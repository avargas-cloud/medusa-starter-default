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
 * Fetch completed credit memo refund $ for refunds processed in [from, to).
 * Filter: cm.completed_at (the date the refund actually took effect).
 * Returns refund amount in cents (subtotal basis — pre-tax, pre-shipping).
 */
export async function fetchCmRefundsCentsForPeriod(
  pg: any,
  from: string,
  to: string
): Promise<number> {
  const result = await pg.raw(
    `SELECT COALESCE(SUM(
       COALESCE(cm.subtotal,
                GREATEST(cm.total - COALESCE(cm.tax,0) - COALESCE(cm.shipping,0), 0))
     ), 0)::bigint AS refund_cents
     FROM pos_credit_memo cm
     WHERE cm.deleted_at IS NULL
       AND cm.status = 'completed'
       AND COALESCE(cm.completed_at, cm.created_at) >= ?
       AND COALESCE(cm.completed_at, cm.created_at) <  ?`,
    [from, to]
  )
  return Number(result.rows[0]?.refund_cents ?? 0)
}
