// Aggregates inline per-item discounts from order_line_item_adjustment.
// amount is stored in DOLLARS (positive = discount applied).
// Use alongside the pos_invoice alias `i` and pos_invoice_item alias `pii`.

// Medusa re-creates order_line_item_adjustment rows on every order edit (bumping version).
// We deduplicate by taking only the latest version per (item_id, code) before summing.
export const ITEM_DISCOUNT_CTE = `
  item_discounts AS (
    SELECT oli.variant_id, oi.order_id, SUM(latest.amount) AS discount_dollars
    FROM (
      SELECT DISTINCT ON (olia.item_id, olia.code)
        olia.item_id, olia.amount
      FROM order_line_item_adjustment olia
      ORDER BY olia.item_id, olia.code, olia.version DESC
    ) latest
    JOIN order_line_item oli ON oli.id = latest.item_id
    JOIN order_item oi       ON oi.item_id = oli.id
    GROUP BY oli.variant_id, oi.order_id
  )
`

export const ITEM_DISCOUNT_JOIN = `
  LEFT JOIN item_discounts idc
    ON idc.order_id = i.order_id AND idc.variant_id = pii.variant_id
`

// Inline item discount in cents (same unit as pii.total)
export const ITEM_DISCOUNT_CENTS = `ROUND(COALESCE(idc.discount_dollars, 0) * 100)::numeric`
