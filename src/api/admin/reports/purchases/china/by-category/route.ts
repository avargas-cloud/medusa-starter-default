import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { parseDateRange } from "../../../_lib/date-range"
import { TIER1_CTE } from "../../../_lib/category-tier1"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const range = parseDateRange(req)
  if (!range) return res.status(400).json({ error: "from and to are required" })

  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    const result = await pg.raw(
      `WITH RECURSIVE ${TIER1_CTE},
       vb_costs AS (
         SELECT
           vbl.product_variant_id,
           vb.purchase_order_id,
           SUM(vbl.commission_per_unit_cents * vbl.qty) AS commission_cents,
           SUM(vbl.freight_per_unit_cents   * vbl.qty) AS freight_cents,
           SUM(vbl.tariff_per_unit_cents    * vbl.qty) AS tariff_cents,
           SUM(COALESCE(vbl.landed_total_cents, vbl.landed_unit_cost_cents * vbl.qty)) AS landed_cents,
           true                                         AS has_bill
         FROM vendor_bill vb
         JOIN vendor_bill_line vbl ON vbl.vendor_bill_id = vb.id
           AND vbl.line_type = 'product' AND vbl.deleted_at IS NULL
         WHERE vb.status = 'confirmed' AND vb.deleted_at IS NULL
         GROUP BY vbl.product_variant_id, vb.purchase_order_id
       ),
       vb_line_qty AS (
         -- Confirmed billed quantity per PO line (Option A: a PO line can be
         -- billed across multiple shipment bills). Keyed by purchase_order_line_id
         -- so a partial first shipment does NOT zero out the whole line's pending.
         SELECT
           vbl.purchase_order_line_id,
           SUM(vbl.qty) AS billed_qty
         FROM vendor_bill vb
         JOIN vendor_bill_line vbl ON vbl.vendor_bill_id = vb.id
           AND vbl.line_type = 'product' AND vbl.deleted_at IS NULL
         WHERE vb.status = 'confirmed' AND vb.deleted_at IS NULL
           AND vbl.purchase_order_line_id IS NOT NULL
         GROUP BY vbl.purchase_order_line_id
       )
       SELECT
         COALESCE(pt.category, 'Uncategorized')                                    AS category,
         COUNT(DISTINCT pol.product_variant_id)::int                              AS product_count,
         SUM(pol.qty_ordered)::int                                                AS qty_ordered,
         SUM(pol.qty_received)::int                                               AS qty_received,
         SUM(pol.total_cents)::bigint                                             AS product_cost_cents,
         COALESCE(SUM(vbc.commission_cents), 0)::bigint                          AS service_cents,
         COALESCE(SUM(vbc.freight_cents),    0)::bigint                          AS shipping_cents,
         COALESCE(SUM(vbc.tariff_cents),     0)::bigint                          AS tariff_cents,
         COALESCE(SUM(vbc.landed_cents),     0)::bigint                          AS landed_cents,
         SUM(GREATEST(pol.qty_ordered - COALESCE(vlq.billed_qty, 0), 0))::int     AS qty_pending
       FROM purchase_order po
       JOIN purchase_order_line pol ON pol.purchase_order_id = po.id AND pol.deleted_at IS NULL
       LEFT JOIN product_variant pv ON pv.id = pol.product_variant_id AND pv.deleted_at IS NULL
       LEFT JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
       LEFT JOIN product_tier1 pt ON pt.product_id = p.id
       LEFT JOIN vb_costs vbc ON vbc.product_variant_id = pol.product_variant_id
         AND vbc.purchase_order_id = po.id
       LEFT JOIN vb_line_qty vlq ON vlq.purchase_order_line_id = pol.id
       WHERE po.deleted_at IS NULL AND po.status NOT IN ('voided','cancelled')
         AND (p.metadata->>'is_sourced_via_agent')::boolean = true
         AND COALESCE(po.ordered_at, po.created_at) >= ? AND COALESCE(po.ordered_at, po.created_at) < ?
       GROUP BY 1
       ORDER BY product_cost_cents DESC`,
      [range.from, range.to]
    )

    const rows = (result.rows as any[]).map(r => ({
      category:      r.category as string,
      product_count: Number(r.product_count),
      qty_ordered:   Number(r.qty_ordered),
      qty_received:  Number(r.qty_received),
      qty_pending:   Number(r.qty_pending),
      product_cost:  Number(r.product_cost_cents) / 100,
      service:       Number(r.service_cents) / 100,
      shipping:      Number(r.shipping_cents) / 100,
      tariff:        Number(r.tariff_cents) / 100,
      landed:        Number(r.landed_cents) / 100,
    }))

    return res.json({ rows })
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch China by category" })
  }
}
