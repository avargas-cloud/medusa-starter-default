/**
 * GET /admin/purchasing/snapshot
 *
 * Returns the full purchasing snapshot: all variants with their daily sales
 * estimates, ABC-XYZ classes, and reorder quantities.
 *
 * Query params:
 *   abc=A,B,C   — filter by ABC class
 *   xyz=X,Y,Z   — filter by XYZ class
 *   q=...       — filter by SKU or product title (case-insensitive)
 *   limit=N     — default 200
 *   offset=N    — default 0
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

// Excel-derived peak daily sales per SKU — loaded once, used as lower bound
let excelPeak: Record<string, number> | null = null;
function getExcelPeak(): Record<string, number> {
  if (!excelPeak) {
    try {
      const p = path.resolve(process.cwd(), "src/scripts/sync/purchasing-peak-sales.json");
      excelPeak = JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      excelPeak = {};
    }
  }
  return excelPeak!;
}

async function getDb() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  return db;
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const q      = ((req.query as Record<string, string>).q ?? "").trim();
  const abcFilter = ((req.query as Record<string, string>).abc ?? "")
    .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const xyzFilter = ((req.query as Record<string, string>).xyz ?? "")
    .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const limit  = Math.min(5000, parseInt((req.query as Record<string, string>).limit ?? "200", 10) || 200);
  const offset = parseInt((req.query as Record<string, string>).offset ?? "0", 10) || 0;

  const db = await getDb();
  try {
    const conditions: string[] = ["snap.variant_id IS NOT NULL"];
    const params: unknown[] = [];

    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      conditions.push(`(LOWER(pv.sku) LIKE $${params.length} OR LOWER(p.title) LIKE $${params.length})`);
    }
    if (abcFilter.length > 0) {
      params.push(abcFilter);
      conditions.push(`snap.abc_class = ANY($${params.length}::text[])`);
    }
    if (xyzFilter.length > 0) {
      params.push(xyzFilter);
      conditions.push(`snap.xyz_class = ANY($${params.length}::text[])`);
    }

    const where = conditions.join(" AND ");

    const countRes = await db.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total
       FROM purchasing_snapshot snap
       JOIN product_variant pv ON pv.id = snap.variant_id AND pv.deleted_at IS NULL
       JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
       WHERE ${where}`,
      params
    );

    params.push(limit, offset);
    const rows = await db.query(
      `SELECT
         snap.variant_id,
         pv.sku,
         p.title AS product_title,
         snap.tier0_30d,
         snap.sales_q1, snap.sales_q2, snap.sales_q3, snap.sales_q4,
         snap.daily_sales_est, snap.monthly_sales_est,
         snap.cv,
         snap.abc_class, snap.xyz_class, snap.abcxyz_class,
         snap.inv_usa, snap.inv_china,
         snap.qty_to_transfer, snap.qty_to_factory,
         snap.last_calculated_at,
         COALESCE(open_po.on_order, 0)::int AS qty_on_po,
         COALESCE(max_day.max_daily_sales, 0)::int AS max_daily_sales
       FROM purchasing_snapshot snap
       JOIN product_variant pv ON pv.id = snap.variant_id AND pv.deleted_at IS NULL
       JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
       LEFT JOIN (
         SELECT pol.sku_snapshot,
                SUM(GREATEST(0, pol.qty_ordered - pol.qty_received - pol.qty_cancelled))::int AS on_order
         FROM purchase_order_line pol
         JOIN purchase_order po ON po.id = pol.purchase_order_id AND po.deleted_at IS NULL
         WHERE po.status IN ('submitted', 'partially_received')
           AND pol.status IN ('open', 'partial')
           AND pol.deleted_at IS NULL
         GROUP BY pol.sku_snapshot
       ) open_po ON open_po.sku_snapshot = pv.sku
       LEFT JOIN (
         SELECT oli.variant_sku,
                MAX(day_qty)::int AS max_daily_sales
         FROM (
           SELECT oli2.variant_sku,
                  DATE(o.created_at AT TIME ZONE 'America/New_York') AS sale_day,
                  SUM(oi.quantity)::int AS day_qty
           FROM order_item oi
           JOIN order_line_item oli2 ON oli2.id = oi.item_id AND oli2.deleted_at IS NULL
           JOIN "order" o ON o.id = oi.order_id
             AND o.status NOT IN ('canceled', 'archived')
             AND o.deleted_at IS NULL
           WHERE o.created_at >= NOW() - INTERVAL '12 months'
           GROUP BY oli2.variant_sku, DATE(o.created_at AT TIME ZONE 'America/New_York')
         ) oli
         GROUP BY oli.variant_sku
       ) max_day ON max_day.variant_sku = pv.sku
       WHERE ${where}
       ORDER BY snap.abc_class NULLS LAST, snap.daily_sales_est DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const peak = getExcelPeak();
    const snapshot = rows.rows.map((r) => {
      const row = r as Record<string, unknown>;
      const medusaMax = typeof row.max_daily_sales === "number" ? row.max_daily_sales : 0;
      const sku = typeof row.sku === "string" ? row.sku : "";
      return { ...row, max_daily_sales: Math.max(medusaMax, peak[sku] ?? 0) };
    });

    return res.json({
      snapshot,
      count: parseInt(countRes.rows[0]?.total ?? "0", 10),
      limit,
      offset,
    });
  } finally {
    await db.end();
  }
}
