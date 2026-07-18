/**
 * Shared canonical cost SQL expressions (Phase 2 of the cost convergence).
 *
 * ONE source of truth so the ~20 COGS/valuation readers stop hand-rolling
 * divergent COALESCE chains. Two DISTINCT concepts — never mix them:
 *
 *   • avgCostDollars  → the final COGS / average cost (landed for China, QB
 *     average for USA). Reads the backfilled canonical `average_cost` (origin-
 *     correct), treating <= 0 as non-authoritative, then falls back to the raw
 *     purchase cost. NO `qb_avg_cost` fallback — that field is stale/wrong for
 *     China and `average_cost` already encodes the right per-origin value.
 *
 *   • purchaseCostDollars → the raw factory/acquisition cost (no freight).
 *     Used by PO autofill, factory/transfer valuation, pre-landed inventory
 *     value. Keyed on `purchase_cost`.
 *
 * Units: `average_cost` and `purchase_cost` are DOLLARS. Use the *Cents
 * helpers where the caller works in cents.
 *
 * @param pv  SQL alias of the `product_variant` row (default "pv").
 */
export function avgCostDollars(pv = "pv"): string {
  return `COALESCE(
    NULLIF(NULLIF(${pv}.metadata->>'average_cost', '')::numeric, 0),
    ${purchaseCostDollars(pv)}
  )`;
}

export function avgCostCents(pv = "pv"): string {
  return `ROUND(${avgCostDollars(pv)} * 100)`;
}

export function purchaseCostDollars(pv = "pv"): string {
  return `NULLIF(${pv}.metadata->>'purchase_cost', '')::numeric`;
}
