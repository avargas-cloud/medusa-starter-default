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

import { withDb } from "../_lib/db";
import { checkMissingSalesData } from "../../../../services/purchasing/missing-month-check";
import { runPurchasingSnapshot } from "../../../../services/purchasing/snapshot.service";
import { computeTier0Meta } from "../../../../services/purchasing/tier0-window";
import { getExcelPeak } from "../_lib/peak-sales";

const USA_LOC =
  process.env.ECOPOWERTECH_MIAMI_LOCATION_ID ??
  "sloc_01KFS2AV3TAKR141KC2D6JCGTR";
const CHINA_LOC =
  process.env.CHINA_WAREHOUSE_LOCATION_ID ?? "sloc_01KQ14C1CFX30EDD722BF87HDM";

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const q = ((req.query as Record<string, string>).q ?? "").trim();
  const abcFilter = ((req.query as Record<string, string>).abc ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const xyzFilter = ((req.query as Record<string, string>).xyz ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const limit = Math.min(
    5000,
    parseInt((req.query as Record<string, string>).limit ?? "200", 10) || 200
  );
  const offset =
    parseInt((req.query as Record<string, string>).offset ?? "0", 10) || 0;

  // sku / sku[] — exact SKU filter (qs parses ?sku[]=X as req.query.sku)
  const skuParam = req.query["sku"] as string | string[] | undefined;
  const skuFilter: string[] = Array.isArray(skuParam)
    ? skuParam.filter(Boolean)
    : skuParam?.trim()
      ? [skuParam.trim()]
      : [];

  return withDb(async (db) => {
    const conditions: string[] = ["snap.variant_id IS NOT NULL"];
    const params: unknown[] = [];

    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      conditions.push(
        `(LOWER(pv.sku) LIKE $${params.length} OR LOWER(p.title) LIKE $${params.length})`
      );
    }
    if (abcFilter.length > 0) {
      params.push(abcFilter);
      conditions.push(`snap.abc_class = ANY($${params.length}::text[])`);
    }
    if (xyzFilter.length > 0) {
      params.push(xyzFilter);
      conditions.push(`snap.xyz_class = ANY($${params.length}::text[])`);
    }
    if (skuFilter.length > 0) {
      params.push(skuFilter);
      conditions.push(`pv.sku = ANY($${params.length}::text[])`);
    }

    const where = conditions.join(" AND ");

    // COUNT uses only filter params — no location IDs needed here
    const countRes = await db.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total
       FROM purchasing_snapshot snap
       JOIN product_variant pv ON pv.id = snap.variant_id AND pv.deleted_at IS NULL
       JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
       WHERE ${where}`,
      params
    );

    // Location IDs pushed AFTER count — only the main SELECT subqueries use them
    params.push(USA_LOC);
    const usaLocIdx = params.length;
    params.push(CHINA_LOC);
    const chinaLocIdx = params.length;

    params.push(limit, offset);
    const limitIdx = params.length - 1;
    const offsetIdx = params.length;

    const rows = await db.query(
      `SELECT
         snap.variant_id,
         pv.sku,
         p.title AS product_title,
         COALESCE(pv.metadata->>'sales_description', '') AS sales_description,
         snap.tier0_30d,
         snap.sales_q1, snap.sales_q2, snap.sales_q3, snap.sales_q4,
         snap.sales_last_24d,
         snap.unmet_net_30d,
         snap.daily_sales_est, snap.monthly_sales_est,
         snap.cv,
         snap.abc_class, snap.xyz_class, snap.abcxyz_class,
         snap.inv_usa, snap.inv_china, snap.inv_china_alt,
         snap.qty_on_po_china_alt,
         snap.qty_to_transfer, snap.qty_to_factory, snap.production_days,
         snap.first_sale_date,
         snap.last_calculated_at,
         COALESCE((p.metadata->>'is_sourced_via_agent')::boolean, false) AS is_sourced_via_agent,
         COALESCE(open_po_usa.on_order, 0)::int AS qty_on_po,
         COALESCE(open_po_china.on_order, 0)::int AS qty_on_po_china,
         COALESCE(max_day.max_daily_sales, 0)::int AS max_daily_sales,
         COALESCE(res_usa.inv_usa_reserved, 0)::int AS inv_usa_reserved
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
           AND po.stock_location_id = $${usaLocIdx}
         GROUP BY pol.sku_snapshot
       ) open_po_usa ON open_po_usa.sku_snapshot = pv.sku
       LEFT JOIN (
         SELECT pol.sku_snapshot,
                SUM(GREATEST(0, pol.qty_ordered - pol.qty_received - pol.qty_cancelled))::int AS on_order
         FROM purchase_order_line pol
         JOIN purchase_order po ON po.id = pol.purchase_order_id AND po.deleted_at IS NULL
         WHERE po.status IN ('submitted', 'partially_received')
           AND pol.status IN ('open', 'partial')
           AND pol.deleted_at IS NULL
           AND po.stock_location_id = $${chinaLocIdx}
         GROUP BY pol.sku_snapshot
       ) open_po_china ON open_po_china.sku_snapshot = pv.sku
       LEFT JOIN (
         SELECT pii.variant_id,
                MAX(day_qty)::int AS max_daily_sales
         FROM (
           SELECT pii2.variant_id,
                  DATE(pi.issued_at AT TIME ZONE 'America/New_York') AS sale_day,
                  SUM(pii2.quantity - pii2.refunded_quantity)::int AS day_qty
           FROM pos_invoice_item pii2
           JOIN pos_invoice pi ON pi.id = pii2.invoice_id
           WHERE pi.issued_at >= NOW() - INTERVAL '12 months'
             AND pi.status NOT IN ('voided')
             AND pii2.deleted_at IS NULL
             AND pii2.variant_id IS NOT NULL
           GROUP BY pii2.variant_id, DATE(pi.issued_at AT TIME ZONE 'America/New_York')
         ) pii
         GROUP BY pii.variant_id
       ) max_day ON max_day.variant_id = snap.variant_id
       LEFT JOIN (
         SELECT pvii.variant_id,
                COALESCE(SUM(il.reserved_quantity), 0)::int AS inv_usa_reserved
         FROM product_variant_inventory_item pvii
         JOIN inventory_item ii ON ii.id = pvii.inventory_item_id AND ii.deleted_at IS NULL
         JOIN inventory_level il ON il.inventory_item_id = ii.id
           AND il.location_id = $${usaLocIdx} AND il.deleted_at IS NULL
         GROUP BY pvii.variant_id
       ) res_usa ON res_usa.variant_id = snap.variant_id
       WHERE ${where}
       ORDER BY snap.abc_class NULLS LAST, snap.daily_sales_est DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );

    const peak = getExcelPeak();
    const snapshot = rows.rows.map((r) => {
      const row = r as Record<string, unknown>;
      const medusaMax =
        typeof row.max_daily_sales === "number" ? row.max_daily_sales : 0;
      const sku = typeof row.sku === "string" ? row.sku : "";
      return { ...row, max_daily_sales: Math.max(medusaMax, peak[sku] ?? 0) };
    });

    const warnings = await checkMissingSalesData(db);
    const todayET = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/New_York",
    });
    const tier0 = computeTier0Meta(todayET);

    return res.json({
      snapshot,
      count: parseInt(countRes.rows[0]?.total ?? "0", 10),
      limit,
      offset,
      warnings,
      tier0,
    });
  });
}


export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    const force =
      (req.query as Record<string, string>)?.force === "true" ||
      (req.query as Record<string, string>)?.force === "1";
    const result = await runPurchasingSnapshot({ force });
    // Always bump last_calculated_at so the UI reflects the button click time,
    // even when the smart-skip logic processed 0 rows.
    await withDb(async (db) => {
      await db.query(`UPDATE purchasing_snapshot SET last_calculated_at = NOW()`);
    });
    return res.json({ ok: true, processed: result.processed, errors: result.errors, durationMs: result.durationMs });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: (e as Error).message });
  }
}
