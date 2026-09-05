import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { parseDateRange } from "../../_lib/date-range"
import { NET_ITEM_REVENUE } from "../../_lib/revenue-expr"
import { CM_REFUNDS_BY_CUSTOMER_CTE } from "../../_lib/sales-revenue"
import { SHIPPING_BY_CUSTOMER_CTE } from "../../_lib/shipping-revenue"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const range = parseDateRange(req)
  if (!range) return res.status(400).json({ error: "from and to are required" })

  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    const result = await pg.raw(
      `WITH ${CM_REFUNDS_BY_CUSTOMER_CTE},
       ${SHIPPING_BY_CUSTOMER_CTE},
       customer_orders AS (
         SELECT
           i.customer_id,
           COUNT(DISTINCT i.id)::int AS order_count,
           SUM(${NET_ITEM_REVENUE})::bigint    AS revenue
         FROM pos_invoice i
         JOIN pos_invoice_item pii ON pii.invoice_id = i.id AND pii.deleted_at IS NULL
         WHERE i.deleted_at IS NULL AND i.status NOT IN ('draft','voided')
           AND i.customer_id IS NOT NULL
           AND i.issued_at >= ? AND i.issued_at < ?
         GROUP BY i.customer_id
       ),
       net_orders AS (
         SELECT co.customer_id, co.order_count,
                co.revenue - COALESCE(r.cm_refunded, 0)
                  + COALESCE(s.shipping_cents, 0) AS revenue
         FROM customer_orders co
         LEFT JOIN cm_refunds r ON r.customer_id = co.customer_id
         LEFT JOIN ship s ON s.axis_key = co.customer_id
       ),
       bucketed AS (
         SELECT
           CASE WHEN order_count >= 5 THEN '5+' ELSE order_count::text END AS bucket,
           CASE WHEN order_count >= 5 THEN 5    ELSE order_count          END AS bucket_sort,
           revenue
         FROM net_orders
       )
       SELECT
         bucket,
         bucket_sort,
         COUNT(*)::int                                                              AS customer_count,
         SUM(revenue)::bigint                                                       AS total_revenue,
         (SUM(revenue)::numeric / NULLIF(COUNT(*), 0))::bigint                     AS avg_revenue_cents
       FROM bucketed
       GROUP BY bucket, bucket_sort
       ORDER BY bucket_sort`,
      [range.from, range.to, range.from, range.to, range.from, range.to,
       range.from, range.to]
    )

    const rows = (result.rows as any[]).map((r) => ({
      bucket:         r.bucket as string,
      customer_count: Number(r.customer_count),
      total_revenue:  Number(r.total_revenue) / 100,
      avg_revenue:    Number(r.avg_revenue_cents) / 100,
    }))

    return res.json({ rows })
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch purchase frequency" })
  }
}
