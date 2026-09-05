import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { parseDateRange } from "../../_lib/date-range"
import { NET_ITEM_REVENUE } from "../../_lib/revenue-expr"
import { CM_REFUNDS_BY_CUSTOMER_CTE } from "../../_lib/sales-revenue"
import { SHIPPING_BY_CUSTOMER_CTE } from "../../_lib/shipping-revenue"
import { COGS_JOIN, COST_DOLLARS, RETURNED_COST_BY_CUSTOMER_CTE } from "../../_lib/cogs-join"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const range = parseDateRange(req)
  if (!range) return res.status(400).json({ error: "from and to are required" })

  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    const result = await pg.raw(
      `WITH ${CM_REFUNDS_BY_CUSTOMER_CTE},
       ${SHIPPING_BY_CUSTOMER_CTE},
       ${RETURNED_COST_BY_CUSTOMER_CTE},
       first_purchase AS (
         SELECT customer_id, MIN(issued_at) AS first_purchase_at
         FROM pos_invoice
         WHERE deleted_at IS NULL AND status NOT IN ('draft','voided') AND customer_id IS NOT NULL
         GROUP BY customer_id
       ),
       returned_at_grain AS (
         SELECT COALESCE(NULLIF(TRIM(c.metadata->>'qb_customer_type'), ''), 'Unknown') AS customer_type,
                SUM(rc.returned_cost_dollars) AS returned_cost
         FROM returned_cost rc
         JOIN customer c ON c.id = rc.customer_id
         GROUP BY 1
       ),
       refunds_by_type AS (
         SELECT COALESCE(NULLIF(TRIM(c.metadata->>'qb_customer_type'), ''), 'Unknown') AS customer_type,
                SUM(r.cm_refunded)::bigint AS cm_refunded
         FROM cm_refunds r
         JOIN customer c ON c.id = r.customer_id
         GROUP BY 1
       ),
       ship_at_grain AS (
         SELECT COALESCE(NULLIF(TRIM(c.metadata->>'qb_customer_type'), ''), 'Unknown') AS customer_type,
                SUM(s.shipping_cents)::bigint AS shipping_cents
         FROM ship s
         JOIN customer c ON c.id = s.axis_key
         GROUP BY 1
       ),
       gross AS (
       SELECT
         COALESCE(NULLIF(TRIM(c.metadata->>'qb_customer_type'), ''), 'Unknown') AS customer_type,
         COUNT(DISTINCT i.customer_id)::int   AS customer_count,
         COUNT(DISTINCT i.id)::int            AS order_count,
         SUM(${NET_ITEM_REVENUE})::bigint               AS revenue,
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
       )
       SELECT g.*, COALESCE(rt.cm_refunded, 0)::bigint AS cm_refunded,
              COALESCE(sg.shipping_cents, 0)::bigint AS shipping_cents,
              COALESCE(rg2.returned_cost, 0) AS returned_cost
       FROM gross g
       LEFT JOIN refunds_by_type rt ON rt.customer_type = g.customer_type
       LEFT JOIN ship_at_grain sg ON sg.customer_type = g.customer_type
       LEFT JOIN returned_at_grain rg2 ON rg2.customer_type = g.customer_type
       ORDER BY g.revenue DESC`,
      [range.from, range.to, range.from, range.to, range.from, range.to,
       range.from, range.to, range.from, range.to, range.from, range.to]
    )

    const rows = (result.rows as any[]).map((r) => {
      // Ingreso NETO de devoluciones y CON flete — misma convención que
      // sales/by-customer, que es lo que permite que las dos familias den el
      // mismo número, y ahora también el mismo que QuickBooks.
      const revenue =
        (Number(r.revenue) - Number(r.cm_refunded) + Number(r.shipping_cents ?? 0)) / 100
      // El costo de lo devuelto vuelve al estante: no es COGS de este período.
      const cogs    = Number(r.cogs) - Number(r.returned_cost ?? 0)
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
