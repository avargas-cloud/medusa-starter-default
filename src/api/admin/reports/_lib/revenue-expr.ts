// Net item revenue after proportional spread of the invoice-level order discount.
// i.subtotal = SUM(pii.total) - i.discount  (pre-tax net after promotions)
// Multiplying each item by (subtotal / (subtotal + discount)) distributes the
// order discount proportionally across items without changing per-item unit prices.
export const NET_ITEM_REVENUE = `
  CASE WHEN (i.subtotal::numeric + i.discount::numeric) > 0
    THEN pii.total::numeric * i.subtotal::numeric / (i.subtotal::numeric + i.discount::numeric)
    ELSE pii.total::numeric
  END
`
