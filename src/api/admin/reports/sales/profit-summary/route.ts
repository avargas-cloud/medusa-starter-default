import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { parseDateRange } from "../../_lib/date-range"
import { COGS_JOIN, COST_DOLLARS, HAS_COST, RETURNED_COST_BY_CUSTOMER_CTE } from "../../_lib/cogs-join"
import { NET_ITEM_REVENUE } from "../../_lib/revenue-expr"
import { cmNotFraudWriteoffSql } from "../../../../../lib/reports/fraud-writeoff"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const range = parseDateRange(req)
  if (!range) return res.status(400).json({ error: "from and to are required" })

  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    // Top profitable items
    const items = await pg.raw(
      // Tres cosas que esta query no hacía, y las tres movían el ranking:
      //
      //  1. NO restaba devoluciones. Era el único reporte de ventas sin netearlas
      //     (su única mención de "refund" era `refunded_quantity`, en la columna
      //     de cantidad), así que informaba el ingreso bruto de facturación.
      //  2. NO revertía el costo de la mercadería devuelta.
      //  3. El ORDER BY restaba CENTAVOS menos DÓLARES: `NET_ITEM_REVENUE` está
      //     en centavos y `COST_DOLLARS` en dólares — el propio JS de abajo
      //     divide uno por 100 y el otro no. Como el costo en dólares es ~100×
      //     más chico, la resta era casi el revenue: el "Top profitable" venía
      //     ordenando por FACTURACIÓN. Medido: EMSH4V160D15W60 y EPS-SPR-D6024
      //     entran al top 5 por profit real y el orden viejo no los mostraba.
      `WITH cm_by_sku AS (
         SELECT cmi.sku,
                SUM(cmi.line_total)::bigint AS cm_refunded,
                SUM(cmi.quantity)::int      AS cm_qty,
                SUM(COALESCE(cmi.average_unit_cost, 0)
                    * GREATEST(0, cmi.quantity - COALESCE(cmi.damaged_qty, 0))) AS returned_cost
         FROM pos_credit_memo cm
         JOIN pos_credit_memo_item cmi ON cmi.credit_memo_id = cm.id AND cmi.deleted_at IS NULL
         WHERE cm.deleted_at IS NULL AND cm.voided_at IS NULL AND cm.status = 'completed'
        AND ${cmNotFraudWriteoffSql("cm")}
           AND COALESCE(cm.completed_at, cm.created_at) >= ?
           AND COALESCE(cm.completed_at, cm.created_at) <  ?
         GROUP BY cmi.sku
       ),
       gross AS (
         SELECT
           pii.sku,
           MIN(pii.description)                              AS description,
           SUM(pii.quantity)::int                            AS qty_sold,
           SUM(${NET_ITEM_REVENUE})::bigint                  AS revenue,
           SUM(${COST_DOLLARS})::bigint                      AS cogs
         FROM pos_invoice_item pii
         JOIN pos_invoice i ON i.id = pii.invoice_id AND i.deleted_at IS NULL
           AND i.status NOT IN ('draft','voided')
           AND i.issued_at >= ? AND i.issued_at < ?
         ${COGS_JOIN}
         WHERE pii.deleted_at IS NULL AND ${HAS_COST}
         -- Se agrupa por sku SOLO: el JOIN de abajo empareja por sku, y agregar
         -- description al GROUP BY hace que un SKU con dos descripciones (16 en
         -- prod) duplique su fila y reste su devolucion dos veces.
         GROUP BY pii.sku
       )
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
       SELECT g.sku, g.description,
              (g.qty_sold - COALESCE(c.cm_qty, 0))::int         AS qty_sold,
              (g.revenue - COALESCE(c.cm_refunded, 0))::bigint  AS revenue,
              (g.cogs - COALESCE(c.returned_cost, 0))::numeric  AS cogs
       FROM gross g
       LEFT JOIN cm_by_sku c ON c.sku = g.sku
       ORDER BY ((g.revenue - COALESCE(c.cm_refunded, 0)) / 100.0
                 - (g.cogs - COALESCE(c.returned_cost, 0))) DESC
       LIMIT 20`,
      [range.from, range.to, range.from, range.to]
    )

    // Top profitable customers
    const customers = await pg.raw(
      `WITH ${RETURNED_COST_BY_CUSTOMER_CTE},
       cm_by_customer AS (
         SELECT cm.customer_id,
                SUM(COALESCE(cm.subtotal,
                    GREATEST(cm.total - COALESCE(cm.tax,0) - COALESCE(cm.shipping,0), 0)))::bigint AS cm_refunded
         FROM pos_credit_memo cm
         WHERE cm.deleted_at IS NULL AND cm.status = 'completed'
        AND ${cmNotFraudWriteoffSql("cm")}
           AND cm.customer_id IS NOT NULL
           AND COALESCE(cm.completed_at, cm.created_at) >= ?
           AND COALESCE(cm.completed_at, cm.created_at) <  ?
         GROUP BY cm.customer_id
       ),
       gross AS (
         SELECT
           i.customer_id,
           COALESCE(c.first_name || ' ' || c.last_name, c.email, 'Unknown') AS name,
           SUM(${NET_ITEM_REVENUE})::bigint                  AS revenue,
           SUM(${COST_DOLLARS})::bigint                      AS cogs
         FROM pos_invoice i
         LEFT JOIN customer c ON c.id = i.customer_id
         JOIN pos_invoice_item pii ON pii.invoice_id = i.id AND pii.deleted_at IS NULL
         ${COGS_JOIN}
         WHERE i.deleted_at IS NULL
           AND i.status NOT IN ('draft','voided')
           AND i.issued_at >= ? AND i.issued_at < ?
         GROUP BY i.customer_id, c.first_name, c.last_name, c.email
       )
       SELECT g.customer_id, g.name,
              (g.revenue - COALESCE(m.cm_refunded, 0))::bigint       AS revenue,
              (g.cogs - COALESCE(rc.returned_cost_dollars, 0))::numeric AS cogs
       FROM gross g
       LEFT JOIN cm_by_customer m ON m.customer_id = g.customer_id
       LEFT JOIN returned_cost rc ON rc.customer_id = g.customer_id
       ORDER BY ((g.revenue - COALESCE(m.cm_refunded, 0)) / 100.0
                 - (g.cogs - COALESCE(rc.returned_cost_dollars, 0))) DESC
       LIMIT 20`,
      [range.from, range.to, range.from, range.to, range.from, range.to]
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
