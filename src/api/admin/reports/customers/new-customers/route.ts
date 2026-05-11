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
       ),
       new_customer_ids AS (
         SELECT fp.customer_id, fp.first_purchase_at
         FROM first_purchase fp
         JOIN customer c ON c.id = fp.customer_id
         WHERE fp.first_purchase_at >= ? AND fp.first_purchase_at < ?
           AND (c.metadata->>'legacy_customer') IS DISTINCT FROM 'true'
       ),
       period_stats AS (
         SELECT
           i.customer_id,
           COUNT(DISTINCT i.id)::int   AS order_count,
           SUM(pii.total)::bigint      AS revenue,
           SUM(${COST_DOLLARS})::bigint  AS cogs
         FROM pos_invoice i
         JOIN pos_invoice_item pii ON pii.invoice_id = i.id AND pii.deleted_at IS NULL
         ${COGS_JOIN}
         WHERE i.deleted_at IS NULL AND i.status NOT IN ('draft','voided')
           AND i.customer_id IS NOT NULL
           AND i.issued_at >= ? AND i.issued_at < ?
         GROUP BY i.customer_id
       )
       SELECT
         nci.customer_id,
         NULLIF(TRIM(COALESCE(c.company_name, '')), '')                                      AS company_name,
         NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), '')    AS full_name,
         c.email,
         c.phone,
         c.metadata->>'qb_price_level'                                                       AS price_level,
         c.created_at,
         nci.first_purchase_at                                                               AS first_order_at,
         COALESCE(ps.order_count, 0)  AS order_count,
         COALESCE(ps.revenue, 0)      AS revenue,
         COALESCE(ps.cogs, 0)         AS cogs
       FROM new_customer_ids nci
       JOIN customer c ON c.id = nci.customer_id
       LEFT JOIN period_stats ps ON ps.customer_id = nci.customer_id
       ORDER BY nci.first_purchase_at DESC`,
      [range.from, range.to, range.from, range.to]
    )

    const rows = (result.rows as any[]).map((r) => {
      const revenue = Number(r.revenue) / 100
      const cogs    = Number(r.cogs)
      const profit  = revenue - cogs
      return {
        customer_id:   r.customer_id,
        company_name:  r.company_name ?? null,
        full_name:     r.full_name ?? null,
        email:         r.email ?? null,
        phone:         r.phone ?? null,
        price_level:   r.price_level ?? null,
        created_at:    r.created_at,
        order_count:   Number(r.order_count),
        revenue,
        gross_profit:  profit,
        margin_pct:    revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : 0,
        first_order_at: r.first_order_at ?? null,
      }
    })

    return res.json({ rows, total: rows.length })
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch new customers" })
  }
}
