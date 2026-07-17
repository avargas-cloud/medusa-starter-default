/**
 * GET /admin/pos/variant-dims
 *
 * Lists product variants (SKUs) with their per-unit shipping dimensions and CBM,
 * for the store-pos "CBM" page. Dimensions are read from the EXACT source of
 * truth: product_variant.metadata.shipping_{length,width,height,weight} (inches /
 * lb) and metadata.cbm (m³). Native columns are ignored here because legacy data
 * rounded them; metadata holds the precise values.
 *
 * Query: q? (search sku / product title / variant title), limit (default 100,
 * max 500), offset, missing? ("1" = only rows without a stored cbm).
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

type KnexInstance = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

interface VariantDimRow {
  id: string;
  sku: string | null;
  variant_title: string | null;
  product_title: string | null;
  sales_description: string | null;
  length: number | null;
  width: number | null;
  height: number | null;
  weight: number | null;
  cbm: number | null;
}

function toInt(v: unknown, fallback: number): number {
  const n = typeof v === "string" ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** Coerce a JSONB text value to a finite number, else null. Never throws — a
 * malformed metadata value (e.g. "" or "7 in" from a legacy script) yields null
 * instead of a `::float` cast crashing the whole list query. */
function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

interface RawDimRow {
  id: string;
  sku: string | null;
  variant_title: string | null;
  product_title: string | null;
  sales_description: string | null;
  length: string | number | null;
  width: string | number | null;
  height: string | number | null;
  weight: string | number | null;
  cbm: string | number | null;
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { q, limit, offset, missing, china } = req.query as {
    q?: string;
    limit?: string;
    offset?: string;
    missing?: string;
    china?: string;
  };

  // Cap high enough to fetch the full filtered set in one call for the print sheet.
  const take = Math.min(5000, Math.max(1, toInt(limit, 100)));
  const skip = Math.max(0, toInt(offset, 0));
  const onlyMissing = missing === "1" || missing === "true";
  const onlyChina = china === "1" || china === "true";

  const knex = (
    req.scope as unknown as { resolve: (k: string) => unknown }
  ).resolve("__pg_connection__") as KnexInstance;

  const where: string[] = ["v.deleted_at IS NULL", "p.deleted_at IS NULL"];
  const bindings: unknown[] = [];

  const term = q?.trim().toLowerCase();
  if (term) {
    where.push(
      "(LOWER(v.sku) LIKE ? OR LOWER(p.title) LIKE ? OR LOWER(v.title) LIKE ? OR LOWER(v.metadata->>'sales_description') LIKE ?)"
    );
    const like = `%${term}%`;
    bindings.push(like, like, like, like);
  }
  if (onlyMissing) {
    where.push("(v.metadata->>'cbm') IS NULL");
  }
  if (onlyChina) {
    // China-sourced products carry product.metadata.is_sourced_via_agent = 'true'.
    where.push("(p.metadata->>'is_sourced_via_agent') = 'true'");
  }

  const whereSql = where.join(" AND ");

  const countResult = await knex.raw(
    `SELECT COUNT(*)::int AS count
       FROM product_variant v
       JOIN product p ON p.id = v.product_id
      WHERE ${whereSql}`,
    bindings
  );
  const count = (countResult.rows[0] as { count: number })?.count ?? 0;

  const rowsResult = await knex.raw(
    `SELECT
        v.id,
        v.sku,
        v.title AS variant_title,
        p.title AS product_title,
        v.metadata->>'sales_description' AS sales_description,
        v.metadata->>'shipping_length' AS length,
        v.metadata->>'shipping_width'  AS width,
        v.metadata->>'shipping_height' AS height,
        v.metadata->>'shipping_weight' AS weight,
        v.metadata->>'cbm'             AS cbm
       FROM product_variant v
       JOIN product p ON p.id = v.product_id
      WHERE ${whereSql}
      ORDER BY v.sku ASC NULLS LAST, p.title ASC, v.title ASC, v.id ASC
      LIMIT ? OFFSET ?`,
    [...bindings, take, skip]
  );

  const items: VariantDimRow[] = (rowsResult.rows as RawDimRow[]).map((r) => ({
    id: r.id,
    sku: r.sku,
    variant_title: r.variant_title,
    product_title: r.product_title,
    sales_description: r.sales_description,
    length: toNum(r.length),
    width: toNum(r.width),
    height: toNum(r.height),
    weight: toNum(r.weight),
    cbm: toNum(r.cbm),
  }));

  res.json({ items, count, limit: take, offset: skip });
}
