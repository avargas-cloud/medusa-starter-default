import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { parseDateRange, priorPeriod } from "../../_lib/date-range"
import { COGS_JOIN, COST_DOLLARS } from "../../_lib/cogs-join"
import { NET_ITEM_REVENUE } from "../../_lib/revenue-expr"

const ACTIVE = `i.status NOT IN ('draft','voided')`

async function fetchPeriodStats(pg: any, from: string, to: string) {
  const result = await pg.raw(
    `SELECT
       COUNT(DISTINCT i.id)::int                              AS invoice_count,
       COALESCE(SUM(${NET_ITEM_REVENUE}), 0)::bigint          AS revenue,
       COALESCE(SUM(pii.refunded_quantity * pii.unit_price), 0)::bigint AS refunded,
       COALESCE(SUM(${COST_DOLLARS}), 0)::bigint               AS cogs
     FROM pos_invoice i
     JOIN pos_invoice_item pii ON pii.invoice_id = i.id AND pii.deleted_at IS NULL
     ${COGS_JOIN}
     WHERE i.deleted_at IS NULL AND ${ACTIVE}
       AND i.issued_at >= ? AND i.issued_at < ?`,
    [from, to]
  )
  return result.rows[0]
}

async function fetchInventoryAdjCogs(pg: any, from: string, to: string): Promise<number> {
  const result = await pg.raw(
    `SELECT COALESCE(SUM(
       icl.delta_applied::numeric *
       COALESCE((pv.metadata->>'average_unit_cost')::numeric,
                (pv.metadata->>'qb_avg_cost')::numeric, 0)
     ), 0) AS adj_cogs
     FROM inventory_count ic
     JOIN inventory_count_line icl ON icl.inventory_count_id = ic.id
       AND icl.deleted_at IS NULL AND icl.status = 'applied' AND icl.delta_applied != 0
     LEFT JOIN product_variant pv ON pv.id = icl.product_variant_id
     WHERE ic.deleted_at IS NULL AND ic.voided_at IS NULL
       AND ic.status = 'approved'
       AND ic.applied_at >= ? AND ic.applied_at < ?`,
    [from, to]
  )
  return Number(result.rows[0].adj_cogs)
}

async function fetchTopCustomer(pg: any, from: string, to: string) {
  const result = await pg.raw(
    `SELECT i.customer_id,
       COALESCE(c.first_name || ' ' || c.last_name, c.email) AS name,
       SUM(i.total)::bigint AS revenue
     FROM pos_invoice i
     LEFT JOIN customer c ON c.id = i.customer_id
     WHERE i.deleted_at IS NULL AND ${ACTIVE}
       AND i.issued_at >= ? AND i.issued_at < ?
     GROUP BY i.customer_id, c.first_name, c.last_name, c.email
     ORDER BY SUM(i.total) DESC
     LIMIT 1`,
    [from, to]
  )
  return result.rows[0] ?? null
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const range = parseDateRange(req)
  if (!range) return res.status(400).json({ error: "from and to are required" })

  const prior = priorPeriod(range)
  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    const [curr, prev, topCustomer, adjCogs, prevAdjCogs] = await Promise.all([
      fetchPeriodStats(pg, range.from, range.to),
      fetchPeriodStats(pg, prior.from, prior.to),
      fetchTopCustomer(pg, range.from, range.to),
      fetchInventoryAdjCogs(pg, range.from, range.to),
      fetchInventoryAdjCogs(pg, prior.from, prior.to),
    ])

    const revenue = Number(curr.revenue) / 100    // cents → dollars
    const cogs    = Number(curr.cogs) + adjCogs   // already dollars + inventory adj
    const profit  = revenue - cogs
    const margin_pct  = revenue > 0 ? (profit / revenue) * 100 : 0
    const refunded    = Number(curr.refunded) / 100
    const refund_pct  = revenue > 0 ? (refunded / revenue) * 100 : 0

    const prevRevenue = Number(prev.revenue) / 100
    const prevProfit  = prevRevenue - (Number(prev.cogs) + prevAdjCogs)

    return res.json({
      invoice_count: Number(curr.invoice_count),
      revenue,
      refunded,
      refund_pct:  Math.round(refund_pct  * 10) / 10,
      gross_profit: profit,
      margin_pct:  Math.round(margin_pct  * 10) / 10,
      aov: curr.invoice_count > 0 ? revenue / Number(curr.invoice_count) : 0,
      top_customer: topCustomer
        ? { id: topCustomer.customer_id, name: topCustomer.name, revenue: Number(topCustomer.revenue) / 100 }
        : null,
      prior: {
        invoice_count: Number(prev.invoice_count),
        revenue: prevRevenue,
        gross_profit: prevProfit,
        aov: prev.invoice_count > 0 ? prevRevenue / Number(prev.invoice_count) : 0,
      },
    })
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch sales summary" })
  }
}
