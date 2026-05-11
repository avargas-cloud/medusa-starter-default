import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { parseDateRange } from "../../_lib/date-range"
import { COGS_JOIN, COST_DOLLARS, HAS_COST } from "../../_lib/cogs-join"
import { NET_ITEM_REVENUE } from "../../_lib/revenue-expr"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const range = parseDateRange(req)
  if (!range) return res.status(400).json({ error: "from and to are required" })

  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    // Top profitable items
    const items = await pg.raw(
      `SELECT
         pii.sku,
         pii.description,
         SUM(pii.quantity - pii.refunded_quantity)::int  AS qty_sold,
         SUM(${NET_ITEM_REVENUE})::bigint                AS revenue,
         SUM(${COST_DOLLARS})::bigint                      AS cogs
       FROM pos_invoice_item pii
       JOIN pos_invoice i ON i.id = pii.invoice_id AND i.deleted_at IS NULL
         AND i.status NOT IN ('draft','voided')
         AND i.issued_at >= ? AND i.issued_at < ?
       ${COGS_JOIN}
       WHERE pii.deleted_at IS NULL AND ${HAS_COST}
       GROUP BY pii.sku, pii.description
       ORDER BY (SUM(pii.total) - SUM(${COST_DOLLARS})) DESC
       LIMIT 20`,
      [range.from, range.to]
    )

    // Top profitable customers
    const customers = await pg.raw(
      `SELECT
         i.customer_id,
         COALESCE(c.first_name || ' ' || c.last_name, c.email, 'Unknown') AS name,
         SUM(pii.total)::bigint       AS revenue,
         SUM(${COST_DOLLARS})::bigint AS cogs
       FROM pos_invoice i
       LEFT JOIN customer c ON c.id = i.customer_id
       JOIN pos_invoice_item pii ON pii.invoice_id = i.id AND pii.deleted_at IS NULL
       ${COGS_JOIN}
       WHERE i.deleted_at IS NULL
         AND i.status NOT IN ('draft','voided')
         AND i.issued_at >= ? AND i.issued_at < ?
       GROUP BY i.customer_id, c.first_name, c.last_name, c.email
       ORDER BY (SUM(pii.total) - SUM(${COST_DOLLARS})) DESC
       LIMIT 20`,
      [range.from, range.to]
    )

    const mapItem = (r: any) => {
      const revenue = Number(r.revenue) / 100
      const cogs    = Number(r.cogs)
      const profit  = revenue - cogs
      return {
        sku: r.sku,
        description: r.description,
        qty_sold: Number(r.qty_sold ?? 0),
        revenue,
        gross_profit: profit,
        margin_pct: revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : 0,
      }
    }

    const mapCustomer = (r: any) => {
      const revenue = Number(r.revenue) / 100
      const cogs    = Number(r.cogs)
      const profit  = revenue - cogs
      return {
        customer_id: r.customer_id,
        name: r.name,
        revenue,
        gross_profit: profit,
        margin_pct: revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : 0,
      }
    }

    return res.json({
      top_items: (items.rows as any[]).map(mapItem),
      top_customers: (customers.rows as any[]).map(mapCustomer),
    })
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch profit summary" })
  }
}
