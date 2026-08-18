/**
 * Shared by the Add (qb-vendor-bill-enqueue.ts) and the Mod
 * (qb-vendor-bill-mod-enqueue.ts): the fail-closed guard that simulates
 * QuickBooks' 5-decimal `<Cost>` truncation (QBXML PRICETYPE; more decimals
 * triggers error 3045) on a bill's item lines. Both ADD and MOD scope this
 * to the identical local/USA, non-clearing branch (`capitalizesFreightHere`)
 * and MUST reach the same verdict on the same bill — a divergence here means
 * the ADD accepts a bill the first MOD then can't reproduce, or vice versa.
 * Extracted so both files literally share the code instead of two copies
 * that can drift apart.
 *
 * CONDITIONAL, not deleted (2026-08-18, owner decision). The bridge
 * (quickbooks-bridge/src/qbxml/builders/bill.ts, already deployed and
 * verified live against production today) emits `<Amount>` for any item
 * line whose payload carries `amount_cents` and derives the unit cost
 * itself — sidestepping the 5-decimal `<Cost>` division entirely, so there
 * is nothing left to round-trip. `allLinesCarryAmount` is what decides
 * whether that is true for THIS bill's payload; when it is, the drift check
 * below is skipped.
 *
 * It stays wired in, not deleted, for the day that condition stops holding:
 * the bridge is a hand-deployed Windows process with no CI/CD (a rollback is
 * a real operational possibility, not hypothetical), and any future payload
 * path that stops setting `amount_cents` — a legacy route, a bug, a partial
 * revert — puts the truncated `<Cost>` back on the wire. In that world this
 * guard is the only thing standing between a short bill and an A/P balance
 * that never clears.
 */

export interface CostTruncationLine {
  qty: number;
  unit_cost_cents: number;
  tax_share_cents: number;
  freight_share_cents: number;
  /** The exact total that will ship as this line's `amount_cents`, if any. */
  amount_cents: number;
}

/** True only when EVERY line's payload will carry a finite `amount_cents`. */
export function allLinesCarryAmount(lines: CostTruncationLine[]): boolean {
  return lines.every((l) => Number.isFinite(l.amount_cents));
}

/**
 * Worst-case drift (in cents) between the exact per-line total and what
 * survives QuickBooks' 5-decimal `<Cost>` truncation, round-tripped back
 * through `quantity × truncated cost`. Zero means every line's `<Cost>`
 * would land exactly on the exact total; `qty <= 0` lines are skipped (they
 * never ship as item lines in the first place).
 */
export function costTruncationDriftCents(lines: CostTruncationLine[]): number {
  return lines.reduce((worst, l) => {
    const qty = Number(l.qty);
    if (qty <= 0) return worst;
    const exact =
      l.unit_cost_cents * qty + l.tax_share_cents + l.freight_share_cents;
    const sentCost = Number((exact / qty / 100).toFixed(5));
    return Math.max(worst, Math.abs(Math.round(sentCost * qty * 100) - exact));
  }, 0);
}
