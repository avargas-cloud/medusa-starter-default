import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { parseDateRange } from "../../_lib/date-range"
import { COGS_JOIN, COST_DOLLARS } from "../../_lib/cogs-join"
import { NET_ITEM_REVENUE } from "../../_lib/revenue-expr"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const range = parseDateRange(req)
  if (!range) return res.status(400).json({ error: "from and to are required" })

  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    const result = await pg.raw(
      `SELECT
         i.customer_id,
         NULLIF(TRIM(COALESCE(c.company_name, '')), '')  AS company_name,
         NULLIF(TRIM(COALESCE(c.first_name || ' ' || c.last_name, '')), '') AS full_name,
         c.email,
         c.phone,
         c.metadata->>'qb_price_level'                  AS price_level,
         COUNT(DISTINCT i.id)::int                       AS invoice_count,
         SUM(${NET_ITEM_REVENUE})::bigint                AS revenue,
         SUM(pii.refunded_quantity * pii.unit_price)::bigint AS refunded,
         SUM(${COST_DOLLARS})::bigint                      AS cogs
       FROM pos_invoice i
       LEFT JOIN customer c ON c.id = i.customer_id
       JOIN pos_invoice_item pii ON pii.invoice_id = i.id AND pii.deleted_at IS NULL
       ${COGS_JOIN}
       WHERE i.deleted_at IS NULL
         AND i.status NOT IN ('draft','voided')
         AND i.issued_at >= ? AND i.issued_at < ?
       GROUP BY i.customer_id, c.company_name, c.first_name, c.last_name, c.email, c.phone, c.metadata
       ORDER BY revenue DESC`,
      [range.from, range.to]
    )

    const rows = (result.rows as any[]).map((r) => {
      const revenue = Number(r.revenue) / 100
      const cogs    = Number(r.cogs)
      const profit  = revenue - cogs
      return {
        customer_id: r.customer_id,
        company_name: r.company_name ?? null,
        full_name: r.full_name ?? null,
        email: r.email ?? null,
        phone: r.phone ?? null,
        price_level: r.price_level ?? null,
        invoice_count: Number(r.invoice_count),
        revenue,
        refunded: Number(r.refunded) / 100,
        gross_profit: profit,
        margin_pct: revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : 0,
        aov: r.invoice_count > 0 ? revenue / Number(r.invoice_count) : 0,
      }
    })

    return res.json({ rows, total: rows.length })
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch sales by customer" })
  }
}
