// average_unit_cost (frozen snapshot) and the canonical average_cost are in dollars.
// pos_invoice.total / pos_invoice_item.total are in cents — divide by 100 in JS before returning.
// COST_DOLLARS returns cost already in dollars so no extra division needed.
import { avgCostDollars } from "../../../../lib/cost/cost-sql"

export const COGS_JOIN = `LEFT JOIN product_variant pv ON pv.id = pii.variant_id`

// Frozen per-line snapshot first; then the canonical live cost (origin-correct
// average_cost → purchase). Replaces the old qb_avg_cost fallback, which was
// wrong for China (stale QB avg instead of the landed cost).
export const COST_DOLLARS = `
  COALESCE(pii.average_unit_cost, ${avgCostDollars("pv")}, 0)
  * pii.quantity
`

export const HAS_COST = `
  (pii.average_unit_cost IS NOT NULL OR ${avgCostDollars("pv")} IS NOT NULL)
`

/**
 * Cost of merchandise RETURNED to stock in [from, to) — the COGS *reversal*
 * leg that pairs with `fetchCmRefundsCentsForPeriod`'s revenue reversal.
 *
 * Why this exists (2026-07-23): the canonical revenue figure is NET of refunds
 * (see sales-revenue.ts) but COGS was gross — it never reversed the cost of
 * goods that physically came back. That understates gross profit, and on the
 * supply-chain report it showed up as a hole between the arrows and the
 * Initial → Final inventory swing (June 2026: $1,266.81).
 *
 * Three choices, all deliberate and all matching what the stock ledger does:
 *   - `quantity − damaged_qty`, NOT `quantity`. Damaged units are refunded but
 *     never restocked (credit_memos/[id]/complete restocks exactly this), so
 *     their cost stays an expense — there's no inventory to put it back into.
 *   - `cm.completed_at` + `status = 'completed'`, mirroring the refund leg's
 *     window: stock comes back when the memo is COMPLETED, not when it's
 *     drafted.
 *   - `cmi.average_unit_cost` first, same frozen-snapshot-then-live fallback
 *     as COST_DOLLARS, so the reversal is on the same basis as the charge.
 */
export async function fetchReturnedProductCostDollars(
  pg: { raw: (sql: string, bindings: unknown[]) => Promise<{ rows: { cost?: string | number }[] }> },
  from: string,
  to: string
): Promise<number> {
  const result = await pg.raw(
    `SELECT COALESCE(SUM(
       COALESCE(cmi.average_unit_cost, ${avgCostDollars("pv")}, 0)
       * GREATEST(0, cmi.quantity - COALESCE(cmi.damaged_qty, 0))
     ), 0) AS cost
     FROM pos_credit_memo cm
     JOIN pos_credit_memo_item cmi ON cmi.credit_memo_id = cm.id AND cmi.deleted_at IS NULL
     LEFT JOIN product_variant pv ON pv.id = cmi.variant_id AND pv.deleted_at IS NULL
     WHERE cm.deleted_at IS NULL AND cm.voided_at IS NULL AND cm.status = 'completed'
       AND COALESCE(cm.completed_at, cm.created_at) >= ?
       AND COALESCE(cm.completed_at, cm.created_at) <  ?`,
    [from, to]
  )
  return Number(result.rows[0]?.cost ?? 0)
}
