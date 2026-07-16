/**
 * GET    /admin/purchasing/alternatives/:id  — get alternatives for a primary variant
 * DELETE /admin/purchasing/alternatives/:id  — remove an alternative link
 *
 * :id can be either:
 *  - a product_alternative.id  (for DELETE)
 *  - a product_variant.id      (for GET — returns all alternatives of that primary)
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { withDb } from "../../_lib/db";
import { PROJECT_SIGNAL_CTE, UNMET_L4W_CTE } from "../../_lib/demand-signals";
import { getExcelPeak } from "../../_lib/peak-sales";

const USA_LOC =
  process.env.ECOPOWERTECH_MIAMI_LOCATION_ID ??
  "sloc_01KFS2AV3TAKR141KC2D6JCGTR";
const CHINA_LOC =
  process.env.CHINA_WAREHOUSE_LOCATION_ID ?? "sloc_01KQ14C1CFX30EDD722BF87HDM";

// ── GET — alternatives for a primary variant ─────────────────────────────────

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const variantId = (req.params as Record<string, string>).id;

  return withDb(async (db) => {
    // Primary variant info
    const primaryRow = await db.query<{
      id: string;
      sku: string;
      product_title: string;
      product_id: string;
      inv_usa: number;
      inv_china: number;
      abc_class: string | null;
      xyz_class: string | null;
    }>(
      `
      SELECT
        pv.id, pv.sku,
        p.title AS product_title,
        p.id    AS product_id,
        COALESCE(SUM(CASE WHEN il.location_id = $2 THEN il.stocked_quantity ELSE 0 END), 0)::int AS inv_usa,
        COALESCE(SUM(CASE WHEN il.location_id = $3 THEN (il.stocked_quantity - il.reserved_quantity) ELSE 0 END), 0)::int AS inv_china,
        snap.abc_class,
        snap.xyz_class
      FROM product_variant pv
      JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
      LEFT JOIN product_variant_inventory_item pvii ON pvii.variant_id = pv.id
      LEFT JOIN inventory_item ii ON ii.id = pvii.inventory_item_id AND ii.deleted_at IS NULL
      LEFT JOIN inventory_level il ON il.inventory_item_id = ii.id
        AND il.location_id IN ($2, $3) AND il.deleted_at IS NULL
      LEFT JOIN purchasing_snapshot snap ON snap.variant_id = pv.id
      WHERE pv.id = $1 AND pv.deleted_at IS NULL
      GROUP BY pv.id, pv.sku, p.title, p.id, snap.abc_class, snap.xyz_class
    `,
      [variantId, USA_LOC, CHINA_LOC]
    );

    if (!primaryRow.rows.length) {
      return res.status(404).json({ error: "Variant not found" });
    }

    // Alternatives list — FIX H-5: replace correlated subquery with derived-table JOIN
    const altsRows = await db.query<{
      link_id: string;
      priority: number;
      variant_id: string;
      sku: string;
      product_title: string;
      inv_usa: number;
      inv_usa_reserved: number;
      inv_china: number;
      abc_class: string | null;
      xyz_class: string | null;
      daily_sales_est: string | null;
      monthly_sales_est: string | null;
      sales_last_24d: string | null;
      qty_on_po: number;
      qty_on_po_alt: number;
      qty_on_po_china: number;
      po_china_lines: { qty: number; expectedAt: string | null }[];
      qty_on_po_china_alt: number;
      inv_china_alt: number;
      inv_usa_alt: number;
      inv_usa_alt_reserved: number;
      max_daily_sales: number;
      qty_to_factory: number;
      production_days: number;
      is_sourced_via_agent: boolean;
      tier0_30d: string | null;
      sales_q1: string | null;
      sales_q2: string | null;
      sales_q3: string | null;
      sales_q4: string | null;
      cv: string | null;
      unmet_net_30d: string | null;
      // Project-sale guard + L4W-aligned unmet demand — same definitions the parent
      // row uses (see _lib/demand-signals), so an alternative and its primary cannot
      // disagree about the same SKU sitting one row apart in the grid.
      distinct_customers_live: number;
      total_qty_live: number;
      unmet_net_l4w: number;
      first_sale_date: string | null;
      last_calculated_at: string | null;
    }>(
      `
      SELECT
        pa.id         AS link_id,
        pa.priority,
        pv.id         AS variant_id,
        pv.sku,
        p.title       AS product_title,
        COALESCE(pv.metadata->>'sales_description', '') AS sales_description,
        COALESCE(SUM(CASE WHEN il.location_id = $2 THEN il.stocked_quantity   ELSE 0 END), 0)::int AS inv_usa,
        COALESCE(SUM(CASE WHEN il.location_id = $2 THEN il.reserved_quantity  ELSE 0 END), 0)::int AS inv_usa_reserved,
        COALESCE(SUM(CASE WHEN il.location_id = $3 THEN (il.stocked_quantity - il.reserved_quantity) ELSE 0 END), 0)::int AS inv_china,
        snap.abc_class,
        snap.xyz_class,
        snap.daily_sales_est,
        snap.monthly_sales_est,
        COALESCE(snap.sales_last_24d, 0) AS sales_last_24d,
        COALESCE(snap.qty_to_factory, 0)::int AS qty_to_factory,
        COALESCE(snap.inv_china_alt, 0)::int AS inv_china_alt,
        COALESCE(snap.qty_on_po_china_alt, 0)::int AS qty_on_po_china_alt,
        0::int AS inv_usa_alt,
        0::int AS inv_usa_alt_reserved,
        0::int AS qty_on_po_alt,
        COALESCE(snap.production_days, 10)::int AS production_days,
        snap.tier0_30d,
        snap.sales_q1,
        snap.sales_q2,
        snap.sales_q3,
        snap.sales_q4,
        snap.cv,
        snap.unmet_net_30d,
        snap.first_sale_date,
        snap.last_calculated_at,
        COALESCE((p.metadata->>'is_sourced_via_agent')::boolean, false) AS is_sourced_via_agent,
        COALESCE(open_po_usa.on_order, 0)::int AS qty_on_po,
        COALESCE(open_po_china.on_order, 0)::int AS qty_on_po_china,
        COALESCE(open_po_china.lines, '[]'::jsonb) AS po_china_lines,
        COALESCE(max_day.max_daily_sales, 0)::int AS max_daily_sales,
        COALESCE(project_signal.distinct_customers, 0)::int AS distinct_customers_live,
        COALESCE(project_signal.total_qty_live, 0)::int AS total_qty_live,
        COALESCE(unmet_l4w.unmet_net_l4w, 0)::int AS unmet_net_l4w
      FROM product_alternative pa
      JOIN product_variant pv ON pv.id = pa.alt_variant_id AND pv.deleted_at IS NULL
      JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
      LEFT JOIN product_variant_inventory_item pvii ON pvii.variant_id = pv.id
      LEFT JOIN inventory_item ii ON ii.id = pvii.inventory_item_id AND ii.deleted_at IS NULL
      LEFT JOIN inventory_level il ON il.inventory_item_id = ii.id
        AND il.location_id IN ($2, $3) AND il.deleted_at IS NULL
      LEFT JOIN purchasing_snapshot snap ON snap.variant_id = pv.id
      LEFT JOIN (
        SELECT pol.sku_snapshot,
               SUM(GREATEST(0, pol.qty_ordered - pol.qty_received - pol.qty_cancelled))::int AS on_order
        FROM purchase_order_line pol
        JOIN purchase_order po ON po.id = pol.purchase_order_id AND po.deleted_at IS NULL
        WHERE po.status IN ('submitted', 'partially_received')
          AND pol.status IN ('open', 'partial')
          AND pol.deleted_at IS NULL
          AND BTRIM(po.stock_location_id, E' \\t\\n\\r') = $2
        GROUP BY pol.sku_snapshot
      ) open_po_usa ON open_po_usa.sku_snapshot = pv.sku
      LEFT JOIN (
        -- Per-line qty + ETA, not just the summed total — same shape the snapshot
        -- returns, so an alternative row applies the SAME out-of-window exclusion and
        -- pre-arrival-gap alert as its primary. Without the lines, Factory falls back
        -- to counting every open order as available today, and the two rows sitting
        -- one above the other would disagree about the same supply.
        SELECT sku_snapshot,
               SUM(on_order)::int AS on_order,
               -- jsonb, NOT json: this query GROUPs BY these lines (it SUMs inventory levels),
               -- and Postgres has no equality operator for the json type — grouping on it
               -- errors at runtime (type-check cannot catch it; only hitting the endpoint does).
               jsonb_agg(jsonb_build_object('qty', on_order, 'expectedAt', expected_at) ORDER BY expected_at NULLS LAST) AS lines
        FROM (
          SELECT pol.sku_snapshot,
                 GREATEST(0, pol.qty_ordered - pol.qty_received - pol.qty_cancelled) AS on_order,
                 po.expected_at
          FROM purchase_order_line pol
          JOIN purchase_order po ON po.id = pol.purchase_order_id AND po.deleted_at IS NULL
          WHERE po.status IN ('submitted', 'partially_received')
            AND pol.status IN ('open', 'partial')
            AND pol.deleted_at IS NULL
            AND BTRIM(po.stock_location_id, E' \\t\\n\\r') = $3
          UNION ALL
          SELECT fol.sku_snapshot,
                 GREATEST(0, fol.qty_ordered - fol.qty_received - fol.qty_cancelled) AS on_order,
                 fo.expected_at
          FROM factory_order_line fol
          JOIN factory_order fo ON fo.id = fol.factory_order_id AND fo.deleted_at IS NULL
          WHERE fo.status IN ('submitted', 'partially_received')
            AND fol.status IN ('open', 'partial')
            AND fol.deleted_at IS NULL
            AND BTRIM(fo.stock_location_id, E' \\t\\n\\r') = $3
        ) combined
        WHERE on_order > 0
        GROUP BY sku_snapshot
      ) open_po_china ON open_po_china.sku_snapshot = pv.sku
      LEFT JOIN (
        SELECT daily.variant_id,
               MAX(day_qty) AS max_daily_sales
        FROM (
          SELECT pii.variant_id,
                 SUM(pii.quantity - pii.refunded_quantity) AS day_qty
          FROM pos_invoice_item pii
          JOIN pos_invoice pi ON pi.id = pii.invoice_id
          WHERE pi.issued_at >= NOW() - INTERVAL '12 months'
            AND pi.status NOT IN ('voided')
            AND pii.deleted_at IS NULL
          GROUP BY pii.variant_id, DATE(pi.issued_at AT TIME ZONE 'America/New_York')
        ) daily
        GROUP BY daily.variant_id
      ) max_day ON max_day.variant_id = pv.id
      LEFT JOIN (${PROJECT_SIGNAL_CTE}) project_signal ON project_signal.variant_id = pv.id
      LEFT JOIN (${UNMET_L4W_CTE}) unmet_l4w ON unmet_l4w.variant_id = pv.id
      WHERE pa.primary_variant_id = $1
        AND pa.is_active = true AND pa.deleted_at IS NULL
        AND pv.deleted_at IS NULL
      GROUP BY pa.id, pa.priority, pv.id, pv.sku, p.title, pv.metadata,
               snap.abc_class, snap.xyz_class, snap.daily_sales_est, snap.monthly_sales_est,
               snap.sales_last_24d, snap.qty_to_factory, snap.production_days, p.metadata,
               snap.tier0_30d, snap.sales_q1, snap.sales_q2, snap.sales_q3, snap.sales_q4,
               snap.cv, snap.unmet_net_30d, snap.first_sale_date, snap.last_calculated_at,
               snap.inv_china_alt, snap.qty_on_po_china_alt,
               open_po_usa.on_order, open_po_china.on_order, open_po_china.lines, max_day.max_daily_sales,
               project_signal.distinct_customers, project_signal.total_qty_live,
               unmet_l4w.unmet_net_l4w
      ORDER BY pa.priority ASC, pv.sku
    `,
      [variantId, USA_LOC, CHINA_LOC]
    );

    // Reverse links: where this variant is listed as an alternative of others
    const reverseRows = await db.query<{
      link_id: string;
      primary_variant_id: string;
      primary_sku: string;
      primary_title: string;
    }>(
      `
      SELECT pa.id AS link_id, pv.id AS primary_variant_id, pv.sku AS primary_sku, p.title AS primary_title
      FROM product_alternative pa
      JOIN product_variant pv ON pv.id = pa.primary_variant_id AND pv.deleted_at IS NULL
      JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
      WHERE pa.alt_variant_id = $1 AND pa.is_active = true AND pa.deleted_at IS NULL
      ORDER BY pv.sku
    `,
      [variantId]
    );

    const peak = getExcelPeak();
    const alternatives = altsRows.rows.map((r) => ({
      ...r,
      max_daily_sales: Math.max(r.max_daily_sales, peak[r.sku] ?? 0),
    }));

    return res.json({
      primary: primaryRow.rows[0],
      alternatives,
      reverse_links: reverseRows.rows,
    });
  });
}

// ── DELETE — remove a link ───────────────────────────────────────────────────

export async function DELETE(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const linkId = (req.params as Record<string, string>).id;

  return withDb(async (db) => {
    const result = await db.query(
      `UPDATE product_alternative
       SET is_active = false, updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL`,
      [linkId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Link not found" });
    }

    return res.json({ ok: true });
  });
}
