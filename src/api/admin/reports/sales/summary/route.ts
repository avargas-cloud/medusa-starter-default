import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { avgCostDollars } from "../../../../../lib/cost/cost-sql"
import { parseDateRange, priorPeriod } from "../../_lib/date-range"
import { COGS_JOIN, COST_DOLLARS, fetchReturnedProductCostDollars } from "../../_lib/cogs-join"
import {
  NET_ITEM_REVENUE,
  SALES_ACTIVE_STATUSES_SQL,
  SALES_DATE_FILTER_SQL,
  fetchCmRefundsCentsForPeriod,
  fetchFraudWriteoffCentsForPeriod,
} from "../../_lib/sales-revenue"
import { fetchShippingCentsForPeriod } from "../../_lib/shipping-revenue"
import { fetchSettledCommissionCentsForPeriod } from "../../_lib/commission-expr"
import { cmNotFraudWriteoffSql } from "../../../../../lib/reports/fraud-writeoff"

const ACTIVE = SALES_ACTIVE_STATUSES_SQL

// A "sellable" line: anything that isn't a narrative/comment row
// (no variant, no sku, no price). Mirrors the dashboard's client-side filter.
const SELLABLE_LINE_SQL = `
  (pii.variant_id IS NOT NULL OR pii.sku IS NOT NULL OR pii.unit_price > 0)
`

async function fetchPeriodStats(pg: any, from: string, to: string) {
  const result = await pg.raw(
    `SELECT
       COUNT(DISTINCT i.id)::int                                              AS invoice_count,
       COALESCE(SUM(${NET_ITEM_REVENUE}), 0)::bigint                          AS revenue,
       COALESCE(SUM(${COST_DOLLARS}), 0)::bigint                              AS cogs,
       COALESCE(SUM(CASE WHEN ${SELLABLE_LINE_SQL} THEN pii.quantity ELSE 0 END), 0)::int AS units_sold,
       COUNT(DISTINCT CASE WHEN ${SELLABLE_LINE_SQL} THEN COALESCE(pii.variant_id, pii.sku) END)::int AS unique_products
     FROM pos_invoice i
     JOIN pos_invoice_item pii ON pii.invoice_id = i.id AND pii.deleted_at IS NULL
     ${COGS_JOIN}
     WHERE i.deleted_at IS NULL AND ${ACTIVE}
       AND ${SALES_DATE_FILTER_SQL}`,
    [from, to]
  )
  return result.rows[0]
}

// Units returned: completed credit memos in [from, to). Mirrors refund $ window.
async function fetchUnitsReturnedForPeriod(pg: any, from: string, to: string): Promise<number> {
  const result = await pg.raw(
    `SELECT COALESCE(SUM(cmi.quantity), 0)::int AS units
     FROM pos_credit_memo cm
     JOIN pos_credit_memo_item cmi ON cmi.credit_memo_id = cm.id AND cmi.deleted_at IS NULL
     WHERE cm.deleted_at IS NULL AND cm.status = 'completed'
        AND ${cmNotFraudWriteoffSql("cm")}
       AND COALESCE(cm.completed_at, cm.created_at) >= ?
       AND COALESCE(cm.completed_at, cm.created_at) <  ?`,
    [from, to]
  )
  return Number(result.rows[0]?.units ?? 0)
}

async function fetchInventoryAdjCogs(pg: any, from: string, to: string): Promise<number> {
  const result = await pg.raw(
    `SELECT COALESCE(SUM(
       icl.delta_applied::numeric *
       COALESCE(${avgCostDollars("pv")}, 0)
     ), 0) AS adj_cogs
     FROM inventory_count ic
     JOIN inventory_count_line icl ON icl.inventory_count_id = ic.id
       AND icl.deleted_at IS NULL
       AND icl.status IN ('applied', 'overridden') AND icl.delta_applied != 0
     LEFT JOIN product_variant pv ON pv.id = icl.product_variant_id
     WHERE ic.deleted_at IS NULL AND ic.voided_at IS NULL
       AND ic.status IN ('approved', 'partially_applied')
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
       AND ${SALES_DATE_FILTER_SQL}
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
    const [
      curr,
      prev,
      topCustomer,
      adjCogs,
      prevAdjCogs,
      currRefundCents,
      returnedCostDollars,
      prevRefundCents,
      currUnitsRet,
      prevUnitsRet,
      currCommissionCents,
      prevCommissionCents,
      currFraudLossCents,
      prevFraudLossCents,
      currShippingCents,
      prevShippingCents,
    ] = await Promise.all([
      fetchPeriodStats(pg, range.from, range.to),
      fetchPeriodStats(pg, prior.from, prior.to),
      fetchTopCustomer(pg, range.from, range.to),
      fetchInventoryAdjCogs(pg, range.from, range.to),
      fetchInventoryAdjCogs(pg, prior.from, prior.to),
      fetchCmRefundsCentsForPeriod(pg, range.from, range.to),
      fetchReturnedProductCostDollars(pg, range.from, range.to),
      fetchCmRefundsCentsForPeriod(pg, prior.from, prior.to),
      fetchUnitsReturnedForPeriod(pg, range.from, range.to),
      fetchUnitsReturnedForPeriod(pg, prior.from, prior.to),
      fetchSettledCommissionCentsForPeriod(pg, range.from, range.to),
      fetchSettledCommissionCentsForPeriod(pg, prior.from, prior.to),
      fetchFraudWriteoffCentsForPeriod(pg, range.from, range.to),
      fetchFraudWriteoffCentsForPeriod(pg, prior.from, prior.to),
      fetchShippingCentsForPeriod(pg, range.from, range.to),
      fetchShippingCentsForPeriod(pg, prior.from, prior.to),
    ])

    // GAAP-correct definitions:
    //   gross_revenue = total facturado
    //   net_revenue   = gross_revenue − returns
    //   gross_profit  = net_revenue − COGS  ← clave: usa NET, no gross
    //   margin_pct    = gross_profit / net_revenue
    // El flete es INGRESO en QuickBooks (el item `SHIPPING & HANDLING` va a
    // `Sales:Shipping and Delivery Income`). Va como término a nivel FACTURA,
    // nunca dentro de NET_ITEM_REVENUE — ésa es el peso del prorrateo de
    // comisiones ya liquidadas. Detalle: `_lib/shipping-revenue.ts`.
    const gross_revenue = (Number(curr.revenue) + currShippingCents) / 100
    const shipping      = currShippingCents / 100
    const refunded      = currRefundCents / 100         // CM-authoritative refunds
    const net_revenue   = gross_revenue - refunded
    // El costo de lo devuelto vuelve al estante: no es COGS de este período.
    const cogs          = Number(curr.cogs) + adjCogs - Number(returnedCostDollars)
    const gross_profit  = net_revenue - cogs
    const margin_pct    = net_revenue > 0 ? (gross_profit / net_revenue) * 100 : 0
    const refund_pct    = gross_revenue > 0 ? (refunded / gross_revenue) * 100 : 0

    // Comisión LIQUIDADA (settlements confirmed), en DÓLARES — mismo tratamiento
    // que revenue (cents → dollars), NUNCA el de cogs (que ya está en dólares).
    // gross_profit NO cambia de definición: la comisión es una línea nueva.
    const commission              = currCommissionCents / 100
    const profit_after_commissions = gross_profit - commission

    // Pérdida por fraude / bad debt. NO está en `refunded` — un write-off no es
    // una devolución (la mercadería no volvió) y QuickBooks lo lleva a una
    // cuenta de gasto sin tocar las ventas. Se muestra acá para que la pérdida
    // siga siendo visible ahora que dejó de restarse del ingreso.
    const fraud_loss              = currFraudLossCents / 100
    const profit_after_fraud_loss = profit_after_commissions - fraud_loss

    const prevGrossRevenue = (Number(prev.revenue) + prevShippingCents) / 100
    const prevRefunded     = prevRefundCents / 100
    const prevNetRevenue   = prevGrossRevenue - prevRefunded
    const prevCogs         = Number(prev.cogs) + prevAdjCogs
    const prevGrossProfit  = prevNetRevenue - prevCogs
    const prevCommission              = prevCommissionCents / 100
    const prevProfitAfterCommissions  = prevGrossProfit - prevCommission

    const units_sold      = Number(curr.units_sold ?? 0)
    const units_returned  = Number(currUnitsRet ?? 0)
    const net_units       = units_sold - units_returned
    const unique_products = Number(curr.unique_products ?? 0)

    const prevUnitsSold     = Number(prev.units_sold ?? 0)
    const prevUnitsReturned = Number(prevUnitsRet ?? 0)
    const prevUniqueProducts= Number(prev.unique_products ?? 0)

    return res.json({
      invoice_count: Number(curr.invoice_count),
      gross_revenue,
      // Se expone SEPARADO para que la pantalla pueda mostrar de dónde sale la
      // diferencia contra un reporte viejo, en vez de dejarla escondida dentro
      // del total. Ya está SUMADO en gross_revenue: no volver a sumarlo.
      shipping,
      refunded,
      net_revenue,
      refund_pct:  Math.round(refund_pct  * 10) / 10,
      gross_profit,
      commission,
      profit_after_commissions,
      fraud_loss,
      profit_after_fraud_loss,
      margin_pct:  Math.round(margin_pct  * 10) / 10,
      aov: curr.invoice_count > 0 ? gross_revenue / Number(curr.invoice_count) : 0,
      units_sold,
      units_returned,
      net_units,
      unique_products,
      top_customer: topCustomer
        ? { id: topCustomer.customer_id, name: topCustomer.name, revenue: Number(topCustomer.revenue) / 100 }
        : null,
      prior: {
        invoice_count: Number(prev.invoice_count),
        gross_revenue: prevGrossRevenue,
        shipping: prevShippingCents / 100,
        refunded: prevRefunded,
        net_revenue: prevNetRevenue,
        gross_profit: prevGrossProfit,
        commission: prevCommission,
        profit_after_commissions: prevProfitAfterCommissions,
        fraud_loss: prevFraudLossCents / 100,
        profit_after_fraud_loss:
          prevProfitAfterCommissions - prevFraudLossCents / 100,
        aov: prev.invoice_count > 0 ? prevGrossRevenue / Number(prev.invoice_count) : 0,
        units_sold: prevUnitsSold,
        units_returned: prevUnitsReturned,
        net_units: prevUnitsSold - prevUnitsReturned,
        unique_products: prevUniqueProducts,
      },
    })
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch sales summary" })
  }
}
