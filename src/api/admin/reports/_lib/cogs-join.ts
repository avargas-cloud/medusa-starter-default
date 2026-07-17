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
