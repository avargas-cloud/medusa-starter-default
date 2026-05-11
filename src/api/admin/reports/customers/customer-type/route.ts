import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { parseDateRange } from "../../_lib/date-range"
import { COGS_JOIN, COST_DOLLARS } from "../../_lib/cogs-join"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const range = parseDateRange(req)
  if (!range) return res.status(400).json({ error: "from and to are required" })

  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    const result = await pg.raw(
      `WITH first_purchase AS (
         SELECT customer_id, MIN(issued_at) AS first_purchase_at
         FROM pos_invoice
         WHERE deleted_at IS NULL AND status NOT IN ('draft','voided') AND customer_id IS NOT NULL
         GROUP BY customer_id
       )
       SELECT
         COALESCE(NULLIF(TRIM(c.metadata->>'qb_customer_type'), ''), 'Unknown') AS customer_type,
         COUNT(DISTINCT i.customer_id)::int   AS customer_count,
         COUNT(DISTINCT i.id)::int            AS order_count,
         SUM(pii.total)::bigint               AS revenue,
         SUM(${COST_DOLLARS})::bigint           AS cogs,
         COUNT(DISTINCT CASE
           WHEN fp.first_purchase_at >= ? AND fp.first_purchase_at < ?
                AND (c.metadata->>'legacy_customer') IS DISTINCT FROM 'true'
           THEN i.customer_id
         END)::int                            AS new_customers
       FROM pos_invoice i
       JOIN pos_invoice_item pii ON pii.invoice_id = i.id AND pii.deleted_at IS NULL
       ${COGS_JOIN}
       JOIN customer c ON c.id = i.customer_id
       JOIN first_purchase fp ON fp.customer_id = i.customer_id
       WHERE i.deleted_at IS NULL AND i.status NOT IN ('draft','voided')
         AND i.customer_id IS NOT NULL
         AND i.issued_at >= ? AND i.issued_at < ?
       GROUP BY 1
       ORDER BY revenue DESC`,
      [range.from, range.to, range.from, range.to]
    )

    const rows = (result.rows as any[]).map((r) => {
      const revenue = Number(r.revenue) / 100
      const cogs    = Number(r.cogs)
      const profit  = revenue - cogs
      return {
        customer_type:  r.customer_type as string,
        customer_count: Number(r.customer_count),
        new_customers:  Number(r.new_customers),
        order_count:    Number(r.order_count),
        revenue,
        gross_profit:   profit,
        margin_pct:     revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : 0,
        aov:            Number(r.order_count) > 0 ? revenue / Number(r.order_count) : 0,
      }
    })

    return res.json({ rows })
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch customer type report" })
  }
}
