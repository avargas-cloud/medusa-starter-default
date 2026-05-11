import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { parseDateRange } from "../../_lib/date-range"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const range = parseDateRange(req)
  if (!range) return res.status(400).json({ error: "from and to are required" })

  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    const result = await pg.raw(
      `WITH customer_orders AS (
         SELECT
           i.customer_id,
           COUNT(DISTINCT i.id)::int AS order_count,
           SUM(pii.total)::bigint    AS revenue
         FROM pos_invoice i
         JOIN pos_invoice_item pii ON pii.invoice_id = i.id AND pii.deleted_at IS NULL
         WHERE i.deleted_at IS NULL AND i.status NOT IN ('draft','voided')
           AND i.customer_id IS NOT NULL
           AND i.issued_at >= ? AND i.issued_at < ?
         GROUP BY i.customer_id
       ),
       bucketed AS (
         SELECT
           CASE WHEN order_count >= 5 THEN '5+' ELSE order_count::text END AS bucket,
           CASE WHEN order_count >= 5 THEN 5    ELSE order_count          END AS bucket_sort,
           revenue
         FROM customer_orders
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
      [range.from, range.to]
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
