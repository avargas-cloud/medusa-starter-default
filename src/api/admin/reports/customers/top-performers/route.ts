import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { parseDateRange } from "../../_lib/date-range"
import { NET_ITEM_REVENUE } from "../../_lib/revenue-expr"
import { CM_REFUNDS_BY_CUSTOMER_CTE } from "../../_lib/sales-revenue"
import {
  SHIPPING_BY_CUSTOMER_CTE,
  SHIPPING_BY_CUSTOMER_LIFETIME_CTE,
} from "../../_lib/shipping-revenue"
import { COGS_JOIN, COST_DOLLARS, RETURNED_COST_BY_CUSTOMER_CTE } from "../../_lib/cogs-join"
import { cmNotFraudWriteoffSql } from "../../../../../lib/reports/fraud-writeoff"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const range = parseDateRange(req)
  if (!range) return res.status(400).json({ error: "from and to are required" })

  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    const result = await pg.raw(
      `WITH ${CM_REFUNDS_BY_CUSTOMER_CTE},
       ${SHIPPING_BY_CUSTOMER_CTE},
       ${SHIPPING_BY_CUSTOMER_LIFETIME_CTE},
       ${RETURNED_COST_BY_CUSTOMER_CTE},
       -- lifetime NO lleva ventana: su contraparte de ingreso tampoco la lleva.
       cm_refunds_lifetime AS (
         SELECT cm.customer_id, SUM(COALESCE(cm.subtotal,
                  GREATEST(cm.total - COALESCE(cm.tax,0) - COALESCE(cm.shipping,0), 0)))::bigint AS cm_refunded
         FROM pos_credit_memo cm
         WHERE cm.deleted_at IS NULL AND cm.status = 'completed'
        AND ${cmNotFraudWriteoffSql("cm")} AND cm.customer_id IS NOT NULL
         GROUP BY cm.customer_id
       ),
       period_cte AS (
         SELECT
           i.customer_id,
           COUNT(DISTINCT i.id)::int          AS period_orders,
           SUM(${NET_ITEM_REVENUE})::bigint             AS period_revenue,
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
           SUM(${NET_ITEM_REVENUE})::bigint             AS lifetime_revenue,
           MIN(i.issued_at)                   AS first_order_at,
           MAX(i.issued_at)                   AS last_order_at
         FROM pos_invoice i
         JOIN pos_invoice_item pii ON pii.invoice_id = i.id AND pii.deleted_at IS NULL
         WHERE i.deleted_at IS NULL AND i.status NOT IN ('draft','voided')
           AND i.customer_id IS NOT NULL
         GROUP BY i.customer_id
       ),
       net_period AS (
         SELECT p.customer_id, p.period_orders, p.period_cogs - COALESCE(rc.returned_cost_dollars, 0) AS period_cogs,
                p.period_revenue - COALESCE(r.cm_refunded, 0)
                  + COALESCE(s.shipping_cents, 0) AS period_revenue
         FROM period_cte p LEFT JOIN cm_refunds r ON r.customer_id = p.customer_id
         LEFT JOIN ship s ON s.axis_key = p.customer_id
         LEFT JOIN returned_cost rc ON rc.customer_id = p.customer_id
       ),
       net_lifetime AS (
         SELECT l.customer_id, l.lifetime_orders, l.first_order_at, l.last_order_at,
                l.lifetime_revenue - COALESCE(rl.cm_refunded, 0)
                  + COALESCE(sl.shipping_cents, 0) AS lifetime_revenue
         FROM lifetime_cte l LEFT JOIN cm_refunds_lifetime rl ON rl.customer_id = l.customer_id
         LEFT JOIN ship_lifetime sl ON sl.axis_key = l.customer_id
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
       FROM net_period pc
       JOIN net_lifetime lc ON lc.customer_id = pc.customer_id
       JOIN customer c ON c.id = pc.customer_id
       ORDER BY pc.period_revenue DESC`,
      [range.from, range.to, range.from, range.to,
       range.from, range.to, range.from, range.to, range.from, range.to]
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
