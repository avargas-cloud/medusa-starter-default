import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { parseDateRange } from "../../_lib/date-range"
import { COGS_JOIN, COST_DOLLARS, RETURNED_COST_BY_CUSTOMER_CTE } from "../../_lib/cogs-join"
import { NET_ITEM_REVENUE } from "../../_lib/revenue-expr"
import { SHIPPING_BY_CUSTOMER_CTE } from "../../_lib/shipping-revenue"
import { cmNotFraudWriteoffSql } from "../../../../../lib/reports/fraud-writeoff"

// Revenue per customer is NET (gross − credit memos completed in the period),
// matching QuickBooks' "Sales by Customer Summary" and the dashboard's
// Net Revenue KPI. Credit memos are attributed to cm.customer_id by the
// date the refund was completed, regardless of when the original invoice
// was issued — same policy as _lib/sales-revenue.ts.
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const range = parseDateRange(req)
  if (!range) return res.status(400).json({ error: "from and to are required" })

  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    const result = await pg.raw(
      `WITH ${RETURNED_COST_BY_CUSTOMER_CTE},
       gross AS (
         SELECT
           i.customer_id,
           COUNT(DISTINCT i.id)::int                         AS invoice_count,
           SUM(${NET_ITEM_REVENUE})::bigint                  AS gross_revenue,
           SUM(pii.refunded_quantity * pii.unit_price)::bigint AS item_refunded,
           SUM(${COST_DOLLARS})::bigint                      AS cogs
         FROM pos_invoice i
         JOIN pos_invoice_item pii ON pii.invoice_id = i.id AND pii.deleted_at IS NULL
         ${COGS_JOIN}
         WHERE i.deleted_at IS NULL
           AND i.status NOT IN ('draft','voided')
           AND i.issued_at >= ? AND i.issued_at < ?
         GROUP BY i.customer_id
       ),
       cm_refunds AS (
         SELECT
           cm.customer_id,
           SUM(COALESCE(cm.subtotal,
                        GREATEST(cm.total - COALESCE(cm.tax,0) - COALESCE(cm.shipping,0), 0))
              )::bigint AS cm_refunded
         FROM pos_credit_memo cm
         WHERE cm.deleted_at IS NULL
           AND cm.status = 'completed'
        AND ${cmNotFraudWriteoffSql("cm")}
           AND COALESCE(cm.completed_at, cm.created_at) >= ?
           AND COALESCE(cm.completed_at, cm.created_at) <  ?
         GROUP BY cm.customer_id
       ),
       ${SHIPPING_BY_CUSTOMER_CTE}
       SELECT
         COALESCE(g.customer_id, r.customer_id)            AS customer_id,
         NULLIF(TRIM(COALESCE(c.company_name, '')), '')    AS company_name,
         NULLIF(TRIM(COALESCE(c.first_name || ' ' || c.last_name, '')), '') AS full_name,
         c.email,
         c.phone,
         c.metadata->>'qb_price_level'                     AS price_level,
         COALESCE(g.invoice_count, 0)                      AS invoice_count,
         COALESCE(g.gross_revenue, 0)::bigint              AS gross_revenue,
         COALESCE(s.shipping_cents, 0)::bigint             AS shipping_cents,
         COALESCE(g.item_refunded, 0)::bigint              AS item_refunded,
         COALESCE(r.cm_refunded, 0)::bigint                AS cm_refunded,
         COALESCE(g.cogs, 0)::bigint                       AS cogs,
         COALESCE(rc.returned_cost_dollars, 0)             AS returned_cost
       FROM gross g
       FULL OUTER JOIN cm_refunds r ON r.customer_id = g.customer_id
       LEFT JOIN ship s ON s.axis_key = COALESCE(g.customer_id, r.customer_id)
       LEFT JOIN returned_cost rc ON rc.customer_id = COALESCE(g.customer_id, r.customer_id)
       LEFT JOIN customer c ON c.id = COALESCE(g.customer_id, r.customer_id)
       ORDER BY (COALESCE(g.gross_revenue, 0) + COALESCE(s.shipping_cents, 0)
                 - COALESCE(r.cm_refunded, 0)) DESC`,
      [range.from, range.to, range.from, range.to, range.from, range.to,
       range.from, range.to, range.from, range.to]
    )

    const rows = (result.rows as any[]).map((r) => {
      // El flete es INGRESO: el item `SHIPPING & HANDLING` de QuickBooks va a
      // una cuenta de Sales, así que sin esto el reporte queda por debajo de QB.
      const gross_revenue = (Number(r.gross_revenue) + Number(r.shipping_cents ?? 0)) / 100
      const cm_refunded   = Number(r.cm_refunded) / 100
      const revenue       = gross_revenue - cm_refunded
      // El costo de lo devuelto vuelve al estante: no es COGS de este período.
      const cogs          = Number(r.cogs) - Number(r.returned_cost ?? 0)
      const profit        = revenue - cogs
      const invoice_count = Number(r.invoice_count)
      return {
        customer_id: r.customer_id,
        company_name: r.company_name ?? null,
        full_name: r.full_name ?? null,
        email: r.email ?? null,
        phone: r.phone ?? null,
        price_level: r.price_level ?? null,
        invoice_count,
        revenue,
        gross_revenue,
        refunded: cm_refunded,
        item_refunded: Number(r.item_refunded) / 100,
        gross_profit: profit,
        margin_pct: revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : 0,
        aov: invoice_count > 0 ? gross_revenue / invoice_count : 0,
      }
    })

    return res.json({ rows, total: rows.length })
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch sales by customer" })
  }
}
