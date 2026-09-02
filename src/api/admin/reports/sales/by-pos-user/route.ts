import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { parseDateRange } from "../../_lib/date-range"
import { COGS_JOIN, COST_DOLLARS } from "../../_lib/cogs-join"
import { NET_ITEM_REVENUE } from "../../_lib/revenue-expr"

// Revenue per sales rep is NET (gross − credit memos completed in the period).
// Gross is attributed to the order's assigned sales rep (order.metadata.sales_rep),
// refunds to cm.sales_rep — the same basis QuickBooks and the invoices list use,
// so all three views reconcile. Attribution is the assigned rep, NOT i.created_by
// (the cashier who issued the invoice). A rep who only issued refunds still
// surfaces via the FULL OUTER JOIN below.
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const range = parseDateRange(req)
  if (!range) return res.status(400).json({ error: "from and to are required" })

  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    const result = await pg.raw(
      `WITH gross AS (
         SELECT
           COALESCE(
             NULLIF(TRIM(o.metadata->'sales_rep'->>'name'), ''),
             'Unassigned Agent'
           )                                                AS pos_user,
           COUNT(DISTINCT i.id)::int                        AS invoice_count,
           COUNT(DISTINCT i.customer_id)::int               AS customer_count,
           SUM(${NET_ITEM_REVENUE})::bigint                 AS gross_revenue,
           SUM(pii.refunded_quantity * pii.unit_price)::bigint AS item_refunded,
           SUM(${COST_DOLLARS})::bigint                     AS cogs
         FROM pos_invoice i
         JOIN pos_invoice_item pii ON pii.invoice_id = i.id AND pii.deleted_at IS NULL
         LEFT JOIN "order" o ON o.id = i.order_id
         ${COGS_JOIN}
         WHERE i.deleted_at IS NULL
           AND i.status NOT IN ('draft','voided')
           AND i.issued_at >= ? AND i.issued_at < ?
         GROUP BY 1
       ),
       returned_by_user AS (
         SELECT COALESCE(NULLIF(TRIM(cm.sales_rep->>'name'), ''), 'Unassigned Agent') AS pos_user,
                SUM(COALESCE(cmi.average_unit_cost, 0) * GREATEST(0, cmi.quantity - COALESCE(cmi.damaged_qty, 0))) AS returned_cost
         FROM pos_credit_memo cm
         JOIN pos_credit_memo_item cmi ON cmi.credit_memo_id = cm.id AND cmi.deleted_at IS NULL
         WHERE cm.deleted_at IS NULL
           AND cm.status = 'completed'
           AND COALESCE(cm.completed_at, cm.created_at) >= ?
           AND COALESCE(cm.completed_at, cm.created_at) <  ?
         GROUP BY 1
       ),
       cm_refunds AS (
         SELECT
           COALESCE(NULLIF(TRIM(cm.sales_rep->>'name'), ''), 'Unassigned Agent') AS pos_user,
           SUM(COALESCE(cm.subtotal,
                        GREATEST(cm.total - COALESCE(cm.tax,0) - COALESCE(cm.shipping,0), 0))
              )::bigint AS cm_refunded
         FROM pos_credit_memo cm
         WHERE cm.deleted_at IS NULL
           AND cm.status = 'completed'
           AND COALESCE(cm.completed_at, cm.created_at) >= ?
           AND COALESCE(cm.completed_at, cm.created_at) <  ?
         GROUP BY 1
       )
       SELECT
         COALESCE(g.pos_user, r.pos_user)                  AS pos_user,
         COALESCE(g.invoice_count, 0)                      AS invoice_count,
         COALESCE(g.customer_count, 0)                     AS customer_count,
         COALESCE(g.gross_revenue, 0)::bigint              AS gross_revenue,
         COALESCE(g.item_refunded, 0)::bigint              AS item_refunded,
         COALESCE(r.cm_refunded, 0)::bigint                AS cm_refunded,
         (COALESCE(g.cogs, 0) - COALESCE(ru.returned_cost, 0))::numeric AS cogs
       FROM gross g
       FULL OUTER JOIN cm_refunds r ON r.pos_user = g.pos_user
       LEFT JOIN returned_by_user ru ON ru.pos_user = COALESCE(g.pos_user, r.pos_user)
       ORDER BY (COALESCE(g.gross_revenue, 0) - COALESCE(r.cm_refunded, 0)) DESC`,
      [range.from, range.to, range.from, range.to, range.from, range.to]
    )

    const rows = (result.rows as any[]).map((r) => {
      const gross_revenue = Number(r.gross_revenue) / 100
      const cm_refunded   = Number(r.cm_refunded) / 100
      const revenue       = gross_revenue - cm_refunded
      const cogs          = Number(r.cogs)
      const profit        = revenue - cogs
      const invoice_count = Number(r.invoice_count)
      return {
        pos_user: r.pos_user,
        invoice_count,
        customer_count: Number(r.customer_count),
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
    return res.status(500).json({ error: "Failed to fetch sales by POS user" })
  }
}
