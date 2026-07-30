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
import {
  guardSupervisorPin,
  pinGuardResponse,
  resolveActorId,
} from "../../../../lib/pos/supervisor-pin-guard";
import type { PinConn } from "../../../../lib/pos/verify-supervisor-pin";

// The JSON lives at src/scripts/sync/ — resolve from workspace root
const CATEGORIES_JSON = path.resolve(
  process.cwd(),
  "src/scripts/sync/purchasing-categories.json"
);

type CategorySkuRow = { category: string; sku: string };

const MEDUSA_CATEGORY_HANDLES: Array<{ category: string; handles: string[] }> = [
  {
    category: "Connectors",
    handles: [
    "linear-lighting-accessories",
    "cables",
    "accessories-power-supplies",
    ],
  },
  { category: "LED Strips", handles: ["led-strips"] },
  { category: "LED Modules", handles: ["led-modules-sign-backlighting"] },
  { category: "EasyLED", handles: ["easyled"] },
  { category: "LED Drivers", handles: ["led-drivers"] },
  { category: "LED Channels", handles: ["led-channels"] },
  { category: "Controllers", handles: ["controllers"] },
  { category: "Legrand", handles: ["legrand-switches-dimmers-outlets"] },
  { category: "Landscaping", handles: ["underground-lights-led-landscaping"] },
  { category: "Ceiling Lights", handles: ["ceiling-lights"] },
  { category: "Lutron", handles: ["lutron-switches-dimmers-outlets"] },
];

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
    if (!skuToCategory[sku]) {
      skuToCategory[sku] = category;
    }
  }
  return {
    categories: Array.from(categorySet).sort(),
    sku_to_category: skuToCategory,
    alt_skus: altSkus,
  };
}

async function getMedusaCategorySkuRows(db: {
  query: <T = unknown>(
    sql: string,
    params?: unknown[]
  ) => Promise<{ rows: T[] }>;
}): Promise<CategorySkuRow[]> {
  const entries = MEDUSA_CATEGORY_HANDLES.flatMap(({ category, handles }, index) =>
    handles.map((handle) => ({ category, handle, priority: index }))
  );
  if (entries.length === 0) return [];

  const categories = entries.map((entry) => entry.category);
  const handles = entries.map((entry) => entry.handle);
  const priorities = entries.map((entry) => entry.priority);

  const { rows } = await db.query<CategorySkuRow>(
    `
    WITH RECURSIVE roots(category, handle, priority) AS (
      SELECT * FROM unnest($1::text[], $2::text[], $3::int[])
    ),
    tree(category, category_id, priority) AS (
      SELECT roots.category, pc.id, roots.priority
      FROM roots
      JOIN product_category pc
        ON pc.handle = roots.handle
       AND pc.deleted_at IS NULL

      UNION ALL

      SELECT tree.category, child.id, tree.priority
      FROM tree
      JOIN product_category child
        ON child.parent_category_id = tree.category_id
       AND child.deleted_at IS NULL
    )
    SELECT tree.category, pv.sku
    FROM tree
    JOIN product_category_product pcp
      ON pcp.product_category_id = tree.category_id
    JOIN product p
      ON p.id = pcp.product_id
     AND p.deleted_at IS NULL
    JOIN product_variant pv
      ON pv.product_id = p.id
     AND pv.deleted_at IS NULL
    WHERE pv.sku IS NOT NULL
      AND btrim(pv.sku) <> ''
    GROUP BY tree.category, pv.sku
    ORDER BY MIN(tree.priority), tree.category, pv.sku
    `,
    [categories, handles, priorities]
  );

  return rows;
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

    const medusaRows = await getMedusaCategorySkuRows(db);
    const legacySkuSet = new Set(categoryRows.map((r) => r.sku));
    const combinedRows = [
      ...categoryRows,
      ...medusaRows.filter((r) => !legacySkuSet.has(r.sku)),
    ];

    return res.json(
      buildResponse(
        combinedRows,
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

  // PIN de supervisor. La pantalla de Purchasing Analysis pedia PIN para editar
  // las listas de categoria y comparaba en el navegador: un PUT directo a esta
  // ruta reescribia la lista sin encontrar ninguna puerta. Las listas de
  // categoria alimentan las sugerencias de compra, asi que un cambio silencioso
  // mueve decisiones de plata sin dejar rastro de quien lo hizo.
  {
    const pinDb = req.scope.resolve("__pg_connection__") as unknown as PinConn;
    const guard = await guardSupervisorPin({
      scope: req.scope as unknown as { resolve: (k: string) => unknown },
      db: pinDb,
      pin: (req.body as { supervisor_pin?: unknown } | undefined)?.supervisor_pin,
      actorId: resolveActorId(req),
    });
    if (!guard.ok) {
      const { status, body: pinBody } = pinGuardResponse(guard);
      return res.status(status).json(pinBody);
    }
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
