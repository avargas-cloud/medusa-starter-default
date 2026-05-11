import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { parseDateRange } from "../../_lib/date-range"
import { COGS_JOIN, COST_DOLLARS } from "../../_lib/cogs-join"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const range = parseDateRange(req)
  if (!range) return res.status(400).json({ error: "from and to are required" })

  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    const result = await pg.raw(
      `WITH period_cte AS (
         SELECT
           i.customer_id,
           COUNT(DISTINCT i.id)::int          AS period_orders,
           SUM(pii.total)::bigint             AS period_revenue,
           SUM(${COST_DOLLARS})::bigint         AS period_cogs
         FROM pos_invoice i
         JOIN pos_invoice_item pii ON pii.invoice_id = i.id AND pii.deleted_at IS NULL
         ${COGS_JOIN}
         WHERE i.deleted_at IS NULL AND i.status NOT IN ('draft','voided')
           AND i.customer_id IS NOT NULL
           AND i.issued_at >= ? AND i.issued_at < ?
         GROUP BY i.customer_id
       ),
       lifetime_cte AS (
         SELECT
           i.customer_id,
           COUNT(DISTINCT i.id)::int          AS lifetime_orders,
           SUM(pii.total)::bigint             AS lifetime_revenue,
           MIN(i.issued_at)                   AS first_order_at,
           MAX(i.issued_at)                   AS last_order_at
         FROM pos_invoice i
         JOIN pos_invoice_item pii ON pii.invoice_id = i.id AND pii.deleted_at IS NULL
         WHERE i.deleted_at IS NULL AND i.status NOT IN ('draft','voided')
           AND i.customer_id IS NOT NULL
         GROUP BY i.customer_id
       )
       SELECT
         pc.customer_id,
         NULLIF(TRIM(COALESCE(c.company_name, '')), '')                      AS company_name,
         NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), '') AS full_name,
         c.email,
         c.phone,
         c.metadata->>'qb_price_level'                                       AS price_level,
         pc.period_orders,
         pc.period_revenue,
         pc.period_cogs,
         lc.lifetime_orders,
         lc.lifetime_revenue,
         lc.first_order_at,
         lc.last_order_at
       FROM period_cte pc
       JOIN lifetime_cte lc ON lc.customer_id = pc.customer_id
       JOIN customer c ON c.id = pc.customer_id
       ORDER BY pc.period_revenue DESC`,
      [range.from, range.to]
    )

    const rows = (result.rows as any[]).map((r) => {
      const revenue = Number(r.period_revenue) / 100
      const cogs    = Number(r.period_cogs)
      const profit  = revenue - cogs
      return {
        customer_id:      r.customer_id,
        company_name:     r.company_name ?? null,
        full_name:        r.full_name ?? null,
        email:            r.email ?? null,
        phone:            r.phone ?? null,
        price_level:      r.price_level ?? null,
        period_orders:    Number(r.period_orders),
        period_revenue:   revenue,
        gross_profit:     profit,
        margin_pct:       revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : 0,
        lifetime_orders:  Number(r.lifetime_orders),
        lifetime_revenue: Number(r.lifetime_revenue) / 100,
        first_order_at:   r.first_order_at,
        last_order_at:    r.last_order_at,
      }
    })

    return res.json({ rows, total: rows.length })
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch top performers" })
  }
}
