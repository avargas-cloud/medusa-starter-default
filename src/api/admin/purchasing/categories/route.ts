/**
 * GET  /admin/purchasing/categories   — category list + sku_to_category + alt_skus
 * PUT  /admin/purchasing/categories   — update one category's SKU list
 *   body: { category: string, skus: string[] }
 */

import * as fs from "fs";
import * as path from "path";

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { withDb } from "../_lib/db";

// The JSON lives at src/scripts/sync/ — resolve from workspace root
const CATEGORIES_JSON = path.resolve(
  process.cwd(),
  "src/scripts/sync/purchasing-categories.json"
);

type CategorySkuRow = { category: string; sku: string };

/** Build response shape from flat category+sku rows */
function buildResponse(
  rows: CategorySkuRow[],
  altSkus: string[]
): {
  categories: string[];
  sku_to_category: Record<string, string>;
  alt_skus: string[];
} {
  const categorySet = new Set<string>();
  const skuToCategory: Record<string, string> = {};
  for (const { category, sku } of rows) {
    categorySet.add(category);
    skuToCategory[sku] = category;
  }
  return {
    categories: Array.from(categorySet).sort(),
    sku_to_category: skuToCategory,
    alt_skus: altSkus,
  };
}

export async function GET(
  _req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  return withDb(async (db) => {
    // Query DB table
    const { rows } = await db.query<CategorySkuRow>(
      `SELECT category, sku FROM purchasing_category_sku ORDER BY category, sku`
    );

    let categoryRows = rows;

    // Self-healing one-time migration: if table is empty, seed from JSON file
    if (categoryRows.length === 0) {
      let jsonData: Record<string, string[]> = {};
      try {
        jsonData = JSON.parse(
          fs.readFileSync(CATEGORIES_JSON, "utf-8")
        ) as Record<string, string[]>;
      } catch {
        // JSON not found — return empty response
      }

      const entries = Object.entries(jsonData);
      if (entries.length > 0) {
        // Insert all rows in a single transaction
        await db.query("BEGIN");
        try {
          for (const [category, skus] of entries) {
            for (const sku of skus) {
              if (!sku.trim()) continue;
              await db.query(
                `INSERT INTO purchasing_category_sku (category, sku)
                 VALUES ($1, $2)
                 ON CONFLICT (category, sku) DO NOTHING`,
                [category, sku.trim()]
              );
            }
          }
          await db.query("COMMIT");
        } catch (err) {
          await db.query("ROLLBACK");
          throw err;
        }

        // Re-query after migration
        const { rows: migrated } = await db.query<CategorySkuRow>(
          `SELECT category, sku FROM purchasing_category_sku ORDER BY category, sku`
        );
        categoryRows = migrated;
      }
    }

    // Query alt_skus from product_alternative table
    const altRows = await db.query<{ sku: string }>(
      `SELECT DISTINCT pv.sku
       FROM product_alternative pa
       JOIN product_variant pv ON pv.id = pa.alt_variant_id AND pv.deleted_at IS NULL
       WHERE pa.is_active = true AND pa.deleted_at IS NULL`
    );

    return res.json(
      buildResponse(
        categoryRows,
        altRows.rows.map((r) => r.sku)
      )
    );
  });
}

export async function PUT(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const body = req.body as { category?: string; skus?: string[] };
  const { category, skus } = body;

  if (!category || !Array.isArray(skus)) {
    return res.status(400).json({ error: "category and skus[] are required" });
  }

  // Deduplicate and trim
  const cleaned = [...new Set(skus.map((s) => s.trim()).filter(Boolean))];

  return withDb(async (db) => {
    // Verify category exists
    const { rows: existing } = await db.query<{ category: string }>(
      `SELECT DISTINCT category FROM purchasing_category_sku WHERE category = $1 LIMIT 1`,
      [category]
    );
    if (existing.length === 0) {
      return res
        .status(404)
        .json({ error: `Category "${category}" not found` });
    }

    // Transactional replace: delete old rows, insert new sku list
    await db.query("BEGIN");
    try {
      await db.query(
        `DELETE FROM purchasing_category_sku WHERE category = $1`,
        [category]
      );
      for (const sku of cleaned) {
        await db.query(
          `INSERT INTO purchasing_category_sku (category, sku) VALUES ($1, $2)
           ON CONFLICT (category, sku) DO NOTHING`,
          [category, sku]
        );
      }
      await db.query("COMMIT");
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    }

    return res.json({ ok: true, category, count: cleaned.length });
  });
}
