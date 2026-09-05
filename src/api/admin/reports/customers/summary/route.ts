import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { parseDateRange, priorPeriod } from "../../_lib/date-range"
import { NET_ITEM_REVENUE } from "../../_lib/revenue-expr"
import { CM_REFUNDS_BY_CUSTOMER_CTE } from "../../_lib/sales-revenue"
import { SHIPPING_BY_CUSTOMER_CTE } from "../../_lib/shipping-revenue"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const range = parseDateRange(req)
  if (!range) return res.status(400).json({ error: "from and to are required" })

  const prior = priorPeriod(range)
  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    const [curr, prev] = await Promise.all([
      pg.raw(
        `WITH ${CM_REFUNDS_BY_CUSTOMER_CTE},
       ${SHIPPING_BY_CUSTOMER_CTE},
         first_purchase AS (
           SELECT customer_id, MIN(issued_at) AS first_purchase_at
           FROM pos_invoice
           WHERE deleted_at IS NULL AND status NOT IN ('draft','voided') AND customer_id IS NOT NULL
           GROUP BY customer_id
         ),
         period_stats AS (
           SELECT i.customer_id,
             COUNT(DISTINCT i.id) AS order_count,
             SUM(${NET_ITEM_REVENUE})::bigint AS revenue
           FROM pos_invoice i
           JOIN pos_invoice_item pii ON pii.invoice_id = i.id AND pii.deleted_at IS NULL
           WHERE i.deleted_at IS NULL AND i.status NOT IN ('draft','voided')
             AND i.customer_id IS NOT NULL
             AND i.issued_at >= ? AND i.issued_at < ?
           GROUP BY i.customer_id
         ),
         net_stats AS (
           SELECT ps.customer_id, ps.order_count,
                  ps.revenue - COALESCE(r.cm_refunded, 0)
                    + COALESCE(s.shipping_cents, 0) AS revenue
           FROM period_stats ps
           LEFT JOIN cm_refunds r ON r.customer_id = ps.customer_id
           LEFT JOIN ship s ON s.axis_key = ps.customer_id
         )
         SELECT
           COUNT(*)::int AS total_customers,
           COUNT(CASE WHEN fp.first_purchase_at >= ? AND fp.first_purchase_at < ?
                           AND (c.metadata->>'legacy_customer') IS DISTINCT FROM 'true' THEN 1 END)::int AS new_customers,
           COUNT(CASE WHEN NOT (fp.first_purchase_at >= ? AND fp.first_purchase_at < ?
                                AND (c.metadata->>'legacy_customer') IS DISTINCT FROM 'true') THEN 1 END)::int AS returning_customers,
           COALESCE(SUM(ps.order_count)::numeric / NULLIF(COUNT(*), 0), 0) AS avg_orders,
           COALESCE(SUM(ps.revenue)::numeric / NULLIF(COUNT(*), 0), 0) AS avg_revenue_cents
         FROM net_stats ps
         JOIN customer c ON c.id = ps.customer_id
         JOIN first_purchase fp ON fp.customer_id = ps.customer_id`,
        [range.from, range.to, range.from, range.to, range.from, range.to,
         range.from, range.to, range.from, range.to, range.from, range.to]
      ),
      pg.raw(
        `SELECT COUNT(DISTINCT customer_id)::int AS total_customers
         FROM pos_invoice
         WHERE deleted_at IS NULL AND status NOT IN ('draft','voided')
           AND customer_id IS NOT NULL
           AND issued_at >= ? AND issued_at < ?`,
        [prior.from, prior.to]
      ),
    ])

    const c = curr.rows[0]
    const p = prev.rows[0]

    return res.json({
      total_customers:    Number(c.total_customers),
      new_customers:      Number(c.new_customers),
      returning_customers: Number(c.returning_customers),
      avg_orders:         Math.round(Number(c.avg_orders) * 10) / 10,
      avg_revenue:        Math.round(Number(c.avg_revenue_cents) / 100 * 100) / 100,
      prior: {
        total_customers: Number(p.total_customers),
      },
    })
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch customers summary" })
  }
}
