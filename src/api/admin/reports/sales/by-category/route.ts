import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { avgCostDollars } from "../../../../../lib/cost/cost-sql"
import { parseDateRange } from "../../_lib/date-range"
import { COGS_JOIN, COST_DOLLARS } from "../../_lib/cogs-join"
import { parseRegion, regionClause } from "../../_lib/region-filter"
import { NET_ITEM_REVENUE } from "../../_lib/revenue-expr"
import { NET_SHIPPING_ROW_SQL, SHIPPING_LINE_LABEL } from "../../_lib/shipping-revenue"
import { TIER1_CTE } from "../../_lib/category-tier1"
import { cmNotFraudWriteoffSql } from "../../../../../lib/reports/fraud-writeoff"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const range = parseDateRange(req)
  if (!range) return res.status(400).json({ error: "from and to are required" })

  const pg = req.scope.resolve("__pg_connection__") as any

  const region = parseRegion(req)
  const regionWhere = regionClause(region)

  // El flete no tiene producto, así que no cae ni en 'usa' ni en 'china': con un
  // filtro de región puesto la fila NO se emite, o estaríamos metiendo plata sin
  // filtrar dentro de una vista filtrada. `region === 'all'` es el único caso en
  // que el total de esta pantalla se compara contra QuickBooks.
  const shipRow = region !== 'all' ? '' : `
         UNION ALL
         SELECT '${SHIPPING_LINE_LABEL}'         AS category,
                NULL::text                     AS category_id,
                0::int                         AS qty_sold,
                s.cents                        AS revenue,
                0::numeric                     AS cogs,
                s.invoices                     AS invoice_count
         FROM (${NET_SHIPPING_ROW_SQL}
         ) s
         WHERE s.cents <> 0`
  const shipBindings = region !== 'all'
    ? []
    : [range.from, range.to, range.from, range.to]

  try {
    const result = await pg.raw(
      `WITH RECURSIVE ${TIER1_CTE},
       gross AS (
         SELECT
           COALESCE(pt.category, 'Uncategorized')                        AS category,
           pt.category_id                                                 AS category_id,
           SUM(pii.quantity)::int                                         AS qty_sold,
           SUM(${NET_ITEM_REVENUE})::bigint                               AS gross_revenue,
           SUM(${COST_DOLLARS})::bigint                                   AS cogs,
           COUNT(DISTINCT pii.invoice_id)::int                            AS invoice_count
         FROM pos_invoice_item pii
         JOIN pos_invoice i ON i.id = pii.invoice_id AND i.deleted_at IS NULL
           AND i.status NOT IN ('draft','voided')
           AND i.issued_at >= ? AND i.issued_at < ?
         ${COGS_JOIN}
         LEFT JOIN product p ON p.id = pv.product_id
         LEFT JOIN product_tier1 pt ON pt.product_id = p.id
         WHERE pii.deleted_at IS NULL ${regionWhere}
         GROUP BY 1, 2
       ),
       cm_refunds AS (
         SELECT
           COALESCE(pt.category, 'Uncategorized')                        AS category,
           pt.category_id                                                 AS category_id,
           SUM(cmi.line_total)::bigint                                   AS cm_refunded,
           SUM(cmi.quantity)::int                                        AS cm_qty,
           -- El costo de lo devuelto vuelve al estante: se resta del COGS.
           -- Se usa quantity menos damaged_qty porque lo dañado se reembolsa
           -- pero NO se restockea: su costo sigue siendo gasto real.
           -- (Sin backticks: adentro de un template literal JS cierran el string.)
           SUM(COALESCE(cmi.average_unit_cost, 0) * GREATEST(0, cmi.quantity - COALESCE(cmi.damaged_qty, 0)))                                        AS returned_cost
         FROM pos_credit_memo cm
         JOIN pos_credit_memo_item cmi ON cmi.credit_memo_id = cm.id AND cmi.deleted_at IS NULL
         LEFT JOIN product_variant pv ON pv.id = cmi.variant_id
         LEFT JOIN product_tier1 pt ON pt.product_id = pv.product_id
         WHERE cm.deleted_at IS NULL
           AND cm.status = 'completed'
        AND ${cmNotFraudWriteoffSql("cm")}
           AND COALESCE(cm.completed_at, cm.created_at) >= ?
           AND COALESCE(cm.completed_at, cm.created_at) <  ?
         GROUP BY 1, 2
       )
       SELECT * FROM (
         SELECT
           COALESCE(g.category, r.category)                              AS category,
           COALESCE(g.category_id, r.category_id)                        AS category_id,
         -- Las unidades se netean con el MISMO credit memo que netea el dinero.
         -- pii.refunded_quantity es acumulativa de por vida (lo dice el modelo:
         -- "cumulative units refunded via credit memos"), asi que atribuia la
         -- devolucion al periodo de la VENTA mientras el dinero se atribuye al
         -- periodo de la DEVOLUCION: dos modelos distintos sobre la misma tabla.
         -- Efecto: un mes cerrado perdia unidades solo al pasar el tiempo, y el
         -- precio promedio por unidad quedaba mal en los SKU con devolucion
         -- cruzada. Restar cm_qty hereda gratis los dos filtros correctos del
         -- CTE: la ventana del periodo y la exclusion de write-offs de fraude
         -- (un write-off no es una devolucion y no devuelve mercaderia).
           (COALESCE(g.qty_sold, 0) - COALESCE(r.cm_qty, 0))::int        AS qty_sold,
           (COALESCE(g.gross_revenue, 0) - COALESCE(r.cm_refunded, 0))::bigint AS revenue,
           (COALESCE(g.cogs, 0) - COALESCE(r.returned_cost, 0))::numeric AS cogs,
           COALESCE(g.invoice_count, 0)::int                             AS invoice_count
         FROM gross g
         FULL OUTER JOIN cm_refunds r
           ON r.category = g.category
           AND COALESCE(r.category_id, '') = COALESCE(g.category_id, '')
         UNION ALL
         SELECT
           'Inventory Adjustment'                                       AS category,
           NULL::text                                                   AS category_id,
           0::int                                                       AS qty_sold,
           0::bigint                                                    AS revenue,
           COALESCE(SUM(
             icl.delta_applied::numeric *
             COALESCE(${avgCostDollars("pv")}, 0)
           ), 0)::numeric                                               AS cogs,
           COUNT(DISTINCT ic.id)::int                                   AS invoice_count
         FROM inventory_count ic
         JOIN inventory_count_line icl ON icl.inventory_count_id = ic.id
           AND icl.deleted_at IS NULL
           AND icl.status IN ('applied', 'overridden') AND icl.delta_applied != 0
         LEFT JOIN product_variant pv ON pv.id = icl.product_variant_id
         WHERE ic.deleted_at IS NULL AND ic.voided_at IS NULL
           AND ic.status IN ('approved', 'partially_applied')
           AND ic.applied_at >= ? AND ic.applied_at < ?
       ${shipRow}
       ) t
       ORDER BY revenue DESC`,
      [range.from, range.to, range.from, range.to, range.from, range.to,
       ...shipBindings]
    )

    const rows = (result.rows as any[]).map((r) => {
      const revenue = Number(r.revenue) / 100
      const cogs    = Number(r.cogs)
      const profit  = revenue - cogs
      return {
        category: r.category,
        category_id: r.category_id ?? null,
        qty_sold: Number(r.qty_sold),
        revenue,
        gross_profit: profit,
        margin_pct: revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : 0,
        invoice_count: Number(r.invoice_count),
      }
    })

    return res.json({ rows, total: rows.length })
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch sales by category" })
  }
}
