import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { parseDateRange } from "../../_lib/date-range"
import { COGS_JOIN, COST_DOLLARS } from "../../_lib/cogs-join"
import { parseRegion, regionClause } from "../../_lib/region-filter"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const range = parseDateRange(req)
  if (!range) return res.status(400).json({ error: "from and to are required" })

  const pg = req.scope.resolve("__pg_connection__") as any
  const region = parseRegion(req)
  const regionWhere = regionClause(region)

  try {
    const result = await pg.raw(
      `SELECT * FROM (
         SELECT
           pii.variant_id,
           pii.sku,
           pii.description,
           p.title                                          AS product_title,
           SUM(pii.quantity - pii.refunded_quantity)::int  AS qty_sold,
           SUM(pii.total)::bigint                          AS revenue,
           SUM(${COST_DOLLARS})::bigint                      AS cogs,
           COUNT(DISTINCT pii.invoice_id)::int             AS invoice_count
         FROM pos_invoice_item pii
         JOIN pos_invoice i ON i.id = pii.invoice_id AND i.deleted_at IS NULL
           AND i.status NOT IN ('draft','voided')
           AND i.issued_at >= ? AND i.issued_at < ?
         ${COGS_JOIN}
         LEFT JOIN product p ON p.id = pv.product_id
         WHERE pii.deleted_at IS NULL AND pii.variant_id IS NOT NULL ${regionWhere}
         GROUP BY pii.variant_id, pii.sku, pii.description, p.title
         UNION ALL
         SELECT
           NULL::text                                                   AS variant_id,
           '__ORDER_DISCOUNT__'                                         AS sku,
           'Order Discount'                                             AS description,
           'Order Discount'                                             AS product_title,
           0::int                                                       AS qty_sold,
           (-COALESCE(SUM(i.discount), 0))::bigint                      AS revenue,
           0::bigint                                                    AS cogs,
           COUNT(DISTINCT CASE WHEN i.discount > 0 THEN i.id END)::int AS invoice_count
         FROM pos_invoice i
         WHERE i.deleted_at IS NULL
           AND i.status NOT IN ('draft','voided')
           AND i.issued_at >= ? AND i.issued_at < ?
           AND i.discount > 0
         UNION ALL
         SELECT
           NULL::text                                                   AS variant_id,
           '__INVENTORY_ADJ__'                                          AS sku,
           'Inventory Adjustment'                                       AS description,
           'Inventory Adjustment'                                       AS product_title,
           0::int                                                       AS qty_sold,
           0::bigint                                                    AS revenue,
           COALESCE(SUM(
             icl.delta_applied::numeric *
             COALESCE((pv.metadata->>'average_unit_cost')::numeric,
                      (pv.metadata->>'qb_avg_cost')::numeric, 0)
           ), 0)::numeric                                               AS cogs,
           COUNT(DISTINCT ic.id)::int                                   AS invoice_count
         FROM inventory_count ic
         JOIN inventory_count_line icl ON icl.inventory_count_id = ic.id
           AND icl.deleted_at IS NULL AND icl.status = 'applied' AND icl.delta_applied != 0
         LEFT JOIN product_variant pv ON pv.id = icl.product_variant_id
         WHERE ic.deleted_at IS NULL AND ic.voided_at IS NULL
           AND ic.status = 'approved'
           AND ic.applied_at >= ? AND ic.applied_at < ?
       ) t
       ORDER BY revenue DESC`,
      [range.from, range.to, range.from, range.to, range.from, range.to]
    )

    const rows = (result.rows as any[]).map((r) => {
      const revenue = Number(r.revenue) / 100
      const cogs    = Number(r.cogs)
      const profit  = revenue - cogs
      return {
        variant_id: r.variant_id,
        sku: r.sku,
        description: r.description,
        product_title: r.product_title,
        qty_sold: Number(r.qty_sold),
        revenue,
        gross_profit: profit,
        margin_pct: revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : 0,
        invoice_count: Number(r.invoice_count),
      }
    })

    return res.json({ rows, total: rows.length })
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch sales by item" })
  }
}
