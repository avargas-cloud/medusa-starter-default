import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { parseDateRange } from "../../_lib/date-range"
import { NET_ITEM_REVENUE } from "../../_lib/revenue-expr"
import { CM_REFUNDS_BY_CUSTOMER_CTE } from "../../_lib/sales-revenue"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const range = parseDateRange(req)
  if (!range) return res.status(400).json({ error: "from and to are required" })

  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    const result = await pg.raw(
      `WITH ${CM_REFUNDS_BY_CUSTOMER_CTE},
       customer_stats AS (
         SELECT
           i.customer_id,
           MIN(i.issued_at) AS first_purchase_ever,
           MAX(CASE WHEN i.issued_at < ? THEN i.issued_at END) AS last_before_period,
           COUNT(DISTINCT CASE WHEN i.issued_at >= ? AND i.issued_at < ? THEN i.id END)::int AS orders_in_period,
           COALESCE(SUM(CASE WHEN i.issued_at >= ? AND i.issued_at < ? THEN ${NET_ITEM_REVENUE} ELSE 0 END), 0)::bigint AS revenue_in_period
         FROM pos_invoice i
         JOIN pos_invoice_item pii ON pii.invoice_id = i.id AND pii.deleted_at IS NULL
         WHERE i.deleted_at IS NULL AND i.status NOT IN ('draft','voided')
           AND i.customer_id IS NOT NULL
         GROUP BY i.customer_id
       ),
       segmented AS (
         SELECT
           cs.customer_id,
           cs.orders_in_period,
           cs.revenue_in_period - COALESCE(r.cm_refunded, 0) AS revenue_in_period,
           CASE
             WHEN cs.orders_in_period > 0
               AND cs.first_purchase_ever >= ? AND cs.first_purchase_ever < ?
               AND (c.metadata->>'legacy_customer') IS DISTINCT FROM 'true'  THEN 'new'
             WHEN cs.orders_in_period > 0                                     THEN 'active'
             WHEN cs.orders_in_period = 0
               AND cs.last_before_period IS NOT NULL
               AND cs.last_before_period >= (?::timestamptz - interval '3 months') THEN 'at_risk'
             WHEN cs.orders_in_period = 0
               AND cs.last_before_period IS NOT NULL
               AND cs.last_before_period < (?::timestamptz - interval '3 months')  THEN 'lost'
           END AS segment
         FROM customer_stats cs
         JOIN customer c ON c.id = cs.customer_id
         LEFT JOIN cm_refunds r ON r.customer_id = cs.customer_id
       )
       SELECT
         segment,
         COUNT(*)::int                  AS customer_count,
         SUM(revenue_in_period)::bigint AS revenue,
         SUM(orders_in_period)::int     AS order_count
       FROM segmented
       WHERE segment IS NOT NULL
       GROUP BY segment
       ORDER BY CASE segment WHEN 'new' THEN 1 WHEN 'active' THEN 2 WHEN 'at_risk' THEN 3 ELSE 4 END`,
      [
        range.from, range.to,   // cm_refunds: ventana de devoluciones
        range.from,             // last_before_period: issued_at < from
        range.from, range.to,   // orders_in_period COUNT
        range.from, range.to,   // revenue_in_period SUM
        range.from, range.to,   // 'new': first_purchase_ever in period
        range.from,             // 'at_risk': last_before_period >= (from - 3m)
        range.from,             // 'lost':    last_before_period <  (from - 3m)
      ]
    )

    const rows = (result.rows as any[]).map((r) => ({
      segment:        r.segment as 'new' | 'active' | 'at_risk' | 'lost',
      customer_count: Number(r.customer_count),
      revenue:        Number(r.revenue) / 100,
      order_count:    Number(r.order_count),
    }))

    return res.json({ rows })
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch activity segments" })
  }
}
