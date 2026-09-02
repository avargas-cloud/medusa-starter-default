import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { avgCostDollars } from "../../../../../lib/cost/cost-sql"
import { parseDateRange } from "../../_lib/date-range"
import { COGS_JOIN, COST_DOLLARS, RETURNED_COST_BY_VARIANT_CTE } from "../../_lib/cogs-join"
import { parseRegion, regionClause } from "../../_lib/region-filter"
import { NET_ITEM_REVENUE } from "../../_lib/revenue-expr"
import { TIER1_CTE } from "../../_lib/category-tier1"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const range = parseDateRange(req)
  if (!range) return res.status(400).json({ error: "from and to are required" })

  const pg = req.scope.resolve("__pg_connection__") as any
  const region = parseRegion(req)
  const regionWhere = regionClause(region)

  try {
    const result = await pg.raw(
      `WITH RECURSIVE ${TIER1_CTE},
       ${RETURNED_COST_BY_VARIANT_CTE},
       gross AS (
         SELECT
           pii.variant_id,
           pii.sku,
           MIN(pii.description)                                            AS description,
           MIN(p.title)                                                    AS product_title,
           MIN(COALESCE(pt.category, 'Uncategorized'))                     AS category,
           SUM(pii.quantity - pii.refunded_quantity)::int                  AS qty_sold,
           SUM(${NET_ITEM_REVENUE})::bigint                                AS gross_revenue,
           SUM(${COST_DOLLARS})::bigint                                    AS cogs,
           COUNT(DISTINCT pii.invoice_id)::int                             AS invoice_count
         FROM pos_invoice_item pii
         JOIN pos_invoice i ON i.id = pii.invoice_id AND i.deleted_at IS NULL
           AND i.status NOT IN ('draft','voided')
           AND i.issued_at >= ? AND i.issued_at < ?
         ${COGS_JOIN}
         LEFT JOIN product p ON p.id = pv.product_id
         LEFT JOIN product_tier1 pt ON pt.product_id = p.id
         WHERE pii.deleted_at IS NULL AND pii.variant_id IS NOT NULL ${regionWhere}
         GROUP BY pii.variant_id, pii.sku
       ),
       cm_refunds AS (
         SELECT
           cmi.variant_id,
           cmi.sku,
           SUM(cmi.line_total)::bigint AS cm_refunded
         FROM pos_credit_memo cm
         JOIN pos_credit_memo_item cmi ON cmi.credit_memo_id = cm.id AND cmi.deleted_at IS NULL
         WHERE cm.deleted_at IS NULL
           AND cm.status = 'completed'
           AND cmi.variant_id IS NOT NULL
           AND COALESCE(cm.completed_at, cm.created_at) >= ?
           AND COALESCE(cm.completed_at, cm.created_at) <  ?
         GROUP BY cmi.variant_id, cmi.sku
       )
       SELECT * FROM (
         SELECT
           COALESCE(g.variant_id, r.variant_id)            AS variant_id,
           COALESCE(g.sku, r.sku)                          AS sku,
           g.description,
           g.product_title,
           COALESCE(g.category, 'Uncategorized')           AS category,
           COALESCE(g.qty_sold, 0)::int                    AS qty_sold,
           (COALESCE(g.gross_revenue, 0) - COALESCE(r.cm_refunded, 0))::bigint AS revenue,
           (COALESCE(g.cogs, 0) - COALESCE(rc.returned_cost_dollars, 0))::numeric AS cogs,
           COALESCE(g.invoice_count, 0)::int               AS invoice_count
         FROM gross g
         FULL OUTER JOIN cm_refunds r ON r.variant_id = g.variant_id
         LEFT JOIN returned_cost_variant rc
           ON rc.variant_id = COALESCE(g.variant_id, r.variant_id)
         UNION ALL
         SELECT
           NULL::text                                                       AS variant_id,
           '__INVENTORY_ADJ__'                                              AS sku,
           'Inventory Adjustment'                                           AS description,
           'Inventory Adjustment'                                           AS product_title,
           'Inventory Adjustment'                                           AS category,
           0::int                                                           AS qty_sold,
           0::bigint                                                        AS revenue,
           COALESCE(SUM(
             icl.delta_applied::numeric *
             COALESCE(${avgCostDollars("pv")}, 0)
           ), 0)::numeric                                                   AS cogs,
           COUNT(DISTINCT ic.id)::int                                       AS invoice_count
         FROM inventory_count ic
         JOIN inventory_count_line icl ON icl.inventory_count_id = ic.id
           AND icl.deleted_at IS NULL
           AND icl.status IN ('applied', 'overridden') AND icl.delta_applied != 0
         LEFT JOIN product_variant pv ON pv.id = icl.product_variant_id
         WHERE ic.deleted_at IS NULL AND ic.voided_at IS NULL
           AND ic.status IN ('approved', 'partially_applied')
           AND ic.applied_at >= ? AND ic.applied_at < ?
       ) t
       ORDER BY revenue DESC`,
      [range.from, range.to, range.from, range.to, range.from, range.to, range.from, range.to]
    )

    const rows = (result.rows as any[]).map((r) => {
      const revenue = Number(r.revenue) / 100
      const cogs    = Number(r.cogs)
      const profit  = revenue - cogs
      return {
        variant_id:    r.variant_id,
        sku:           r.sku,
        description:   r.description ?? '',
        product_title: r.product_title,
        category:      r.category ?? 'Uncategorized',
        qty_sold:      Number(r.qty_sold),
        revenue,
        gross_profit:  profit,
        margin_pct:    revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : 0,
        invoice_count: Number(r.invoice_count),
      }
    })

    return res.json({ rows, total: rows.length })
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch sales by item" })
  }
}
