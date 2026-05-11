import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { parseDateRange } from "../../_lib/date-range"
import { COGS_JOIN, COST_DOLLARS } from "../../_lib/cogs-join"
import { parseRegion, regionClause } from "../../_lib/region-filter"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const range = parseDateRange(req)
  if (!range) return res.status(400).json({ error: "from and to are required" })

  const pg = req.scope.resolve("__pg_connection__") as any
  const region = parseRegion(req)
  const regionWhere = regionClause(region)

  try {
    const result = await pg.raw(
      `SELECT
         pii.variant_id,
         pii.sku,
         pii.description,
         p.title                                          AS product_title,
         SUM(pii.quantity - pii.refunded_quantity)::int  AS qty_sold,
         SUM(pii.total)::bigint                          AS revenue,
         SUM(${COST_DOLLARS})::bigint                      AS cogs,
         COUNT(DISTINCT pii.invoice_id)::int             AS invoice_count
       FROM pos_invoice_item pii
       JOIN pos_invoice i ON i.id = pii.invoice_id AND i.deleted_at IS NULL
         AND i.status NOT IN ('draft','voided')
         AND i.issued_at >= ? AND i.issued_at < ?
       ${COGS_JOIN}
       LEFT JOIN product p ON p.id = pv.product_id
       WHERE pii.deleted_at IS NULL AND pii.variant_id IS NOT NULL ${regionWhere}
       GROUP BY pii.variant_id, pii.sku, pii.description, p.title
       ORDER BY revenue DESC`,
      [range.from, range.to]
    )

    const rows = (result.rows as any[]).map((r) => {
      const revenue = Number(r.revenue) / 100
      const cogs    = Number(r.cogs)
      const profit  = revenue - cogs
      return {
        variant_id: r.variant_id,
        sku: r.sku,
        description: r.description,
        product_title: r.product_title,
        qty_sold: Number(r.qty_sold),
        revenue,
        gross_profit: profit,
        margin_pct: revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : 0,
        invoice_count: Number(r.invoice_count),
      }
    })

    return res.json({ rows, total: rows.length })
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch sales by item" })
  }
}
