// average_unit_cost and qb_avg_cost are in dollars.
// pos_invoice.total / pos_invoice_item.total are in cents — divide by 100 in JS before returning.
// COST_DOLLARS returns cost already in dollars so no extra division needed.
export const COGS_JOIN = `LEFT JOIN product_variant pv ON pv.id = pii.variant_id`

export const COST_DOLLARS = `
  COALESCE(pii.average_unit_cost, (pv.metadata->>'qb_avg_cost')::numeric, 0)
  * pii.quantity
`

export const HAS_COST = `
  (pii.average_unit_cost IS NOT NULL OR pv.metadata->>'qb_avg_cost' IS NOT NULL)
`
