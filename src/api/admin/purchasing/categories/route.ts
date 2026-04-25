/**
 * GET  /admin/purchasing/categories   — category list + sku_to_category + alt_skus
 * PUT  /admin/purchasing/categories   — update one category's SKU list
 *   body: { category: string, skus: string[] }
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { Client } from "pg";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

async function getDb() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  return db;
}

// The JSON lives at src/scripts/sync/ — resolve from workspace root
const CATEGORIES_JSON = path.resolve(
  process.cwd(),
  "src/scripts/sync/purchasing-categories.json"
);

function readCategories(): Record<string, string[]> {
  try {
    return JSON.parse(fs.readFileSync(CATEGORIES_JSON, "utf-8"));
  } catch {
    return {};
  }
}

export async function GET(
  _req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const categorySkus = readCategories();
  if (!Object.keys(categorySkus).length) {
    return res.status(500).json({ error: "purchasing-categories.json not found or empty" });
  }

  const skuToCategory: Record<string, string> = {};
  for (const [cat, skus] of Object.entries(categorySkus)) {
    for (const sku of skus) {
      skuToCategory[sku] = cat;
    }
  }

  const db = await getDb();
  try {
    const altRows = await db.query<{ sku: string }>(
      `SELECT DISTINCT pv.sku
       FROM product_alternative pa
       JOIN product_variant pv ON pv.id = pa.alt_variant_id AND pv.deleted_at IS NULL
       WHERE pa.is_active = true AND pa.deleted_at IS NULL`
    );
    return res.json({
      categories: Object.keys(categorySkus),
      sku_to_category: skuToCategory,
      alt_skus: altRows.rows.map((r) => r.sku),
    });
  } finally {
    await db.end();
  }
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

  const categorySkus = readCategories();
  if (!(category in categorySkus)) {
    return res.status(404).json({ error: `Category "${category}" not found` });
  }

  // Deduplicate and trim
  const cleaned = [...new Set(skus.map((s) => s.trim()).filter(Boolean))];
  categorySkus[category] = cleaned;

  try {
    fs.writeFileSync(CATEGORIES_JSON, JSON.stringify(categorySkus, null, 2), "utf-8");
  } catch {
    return res.status(500).json({ error: "Failed to write categories file" });
  }

  return res.json({ ok: true, category, count: cleaned.length });
}
