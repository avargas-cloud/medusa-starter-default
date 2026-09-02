// Canonical definition of "sales revenue" shared across all reports.
//
// Policy (2026-05-25): each financial event is attributed to the period in
// which it occurred — not to the period of the originating document.
//
//   Invoices: included when i.issued_at falls in [from, to).
//     - Statuses: every active invoice (everything except draft and voided).
//     - issued_at is the fiscal date, immune to backdating / re-saves.
//
//   Refunds (credit memos): included when cm.completed_at falls in [from, to).
//     - A return processed in May counts against May's revenue, even if the
//       original invoice was issued in April. The economic event is the refund,
//       not the original sale.
//
// Any report that displays "revenue for period X" MUST source it here.

export const SALES_ACTIVE_STATUSES_SQL = `i.status NOT IN ('draft','voided')`

export const SALES_DATE_COL = `issued_at`

export const SALES_DATE_FILTER_SQL = `i.${SALES_DATE_COL} >= ? AND i.${SALES_DATE_COL} < ?`

/**
 * Gross revenue per invoice line, after proportional spread of the
 * invoice-level order discount. Sums to i.subtotal per invoice.
 */
export { NET_ITEM_REVENUE } from "./revenue-expr"

/**
 * The three pieces of "a refund, in cents". Exported separately so a report
 * that needs refunds BUCKETED (per month, per day) reuses the same definition
 * instead of re-typing it — the trend endpoint needs exactly that, and a second
 * copy of this expression is how two charts on one screen start disagreeing
 * about what a return is worth.
 *
 * Basis is the subtotal (pre-tax, pre-shipping), matching NET_ITEM_REVENUE.
 * Dated by cm.completed_at: the economic event is the refund, not the original
 * sale, so a May return counts against May.
 */
export const CM_REFUND_CENTS_EXPR = `COALESCE(cm.subtotal,
                GREATEST(cm.total - COALESCE(cm.tax,0) - COALESCE(cm.shipping,0), 0))`

export const CM_REFUND_DATE_COL = `COALESCE(cm.completed_at, cm.created_at)`

export const CM_REFUND_SCOPE_SQL = `cm.deleted_at IS NULL
       AND cm.status = 'completed'`

/**
 * Fetch completed credit memo refund $ for refunds processed in [from, to).
 * Returns refund amount in cents.
 */
export async function fetchCmRefundsCentsForPeriod(
  pg: any,
  from: string,
  to: string
): Promise<number> {
  const result = await pg.raw(
    `SELECT COALESCE(SUM(${CM_REFUND_CENTS_EXPR}), 0)::bigint AS refund_cents
     FROM pos_credit_memo cm
     WHERE ${CM_REFUND_SCOPE_SQL}
       AND ${CM_REFUND_DATE_COL} >= ?
       AND ${CM_REFUND_DATE_COL} <  ?`,
    [from, to]
  )
  return Number(result.rows[0]?.refund_cents ?? 0)
}

/**
 * Devoluciones por CLIENTE dentro de la ventana, en centavos.
 *
 * Los 8 reportes de `customers/` no revertían refunds: informaban el ingreso
 * bruto de facturación como si nada hubiera vuelto ($20,146.77 sobre el
 * histórico). Todos agrupan por `customer_id` en su nivel interno, así que este
 * único CTE les sirve a los ocho — y, sobre todo, usa EXACTAMENTE la misma
 * convención que el resto de `sales/`, que es lo que hace que las dos familias
 * de reportes puedan por fin dar el mismo número para el mismo cliente.
 *
 * VIVE ACÁ Y NO EN `revenue-expr.ts` por una razón que costó un boot caído:
 * este archivo ya importa `revenue-expr`, así que el import inverso cierra un
 * CICLO y Medusa muere al registrar las rutas con "Cannot access
 * CM_REFUND_CENTS_EXPR before initialization". `yarn type-check` y `yarn build`
 * pasan los DOS con ese ciclo puesto — sólo lo caza arrancar el servidor.
 *
 * Lleva DOS placeholders `?` (desde, hasta), en el orden en que el CTE aparece
 * en el texto del SQL: al insertarlo hay que reacomodar el array de bindings.
 *
 * OJO — inconsistencia PREEXISTENTE que hereda a propósito: el ingreso se netea
 * de la devolución pero el COGS NO se revierte (sólo `purchases/supply-chain`
 * llama a `fetchReturnedProductCostDollars`). Eso subestima el profit en ambas
 * familias por igual. Se replica en vez de corregirse acá para que `customers/`
 * y `sales/` COINCIDAN; arreglar la reversión de COGS es un cambio propio, para
 * los dos lados a la vez.
 */
export const CM_REFUNDS_BY_CUSTOMER_CTE = `
  cm_refunds AS (
    SELECT cm.customer_id, SUM(${CM_REFUND_CENTS_EXPR})::bigint AS cm_refunded
    FROM pos_credit_memo cm
    WHERE ${CM_REFUND_SCOPE_SQL}
      AND ${CM_REFUND_DATE_COL} >= ? AND ${CM_REFUND_DATE_COL} < ?
      AND cm.customer_id IS NOT NULL
    GROUP BY cm.customer_id
  )
`
