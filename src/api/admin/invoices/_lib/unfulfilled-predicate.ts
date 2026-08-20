/**
 * What makes a POS invoice "still unfulfilled" — ONE definition, two consumers:
 * the [Unfulfilled] tab of /invoices and the badge that counts it. They were
 * written twice and are exactly the pair the house rule warns about: a badge
 * computing its own version of a tab's membership is the list contradicting
 * itself.
 *
 * ── The link clause (2026-08-20) ────────────────────────────────────────────
 * `NOT linkedToOrder` is the one that had to be added, and it comes from a real
 * six-day divergence on S11432 / invoice 21459.
 *
 * That invoice pointed at a live fulfillment stamped `delivered_at` one second
 * after checkout, so this predicate excluded it from the tab — correctly, by
 * what it could see. But the fulfillment was never linked to the order:
 * `create-fulfillment-force` patched `order_item.fulfilled_quantity` by SQL and
 * left no `order_fulfillment` row. The invoice page derives the same state
 * through `order.fulfillments`, which resolves THROUGH that link, so it never
 * found the fulfillment and kept offering "Mark as Picked Up" for six days.
 *
 * One question, two paths to the same table, and a missing link row: the tab
 * was right about the record, the button was right about the goods, and neither
 * could see the other. A fulfillment the ORDER cannot see is not a fulfillment
 * this invoice can claim.
 *
 * NO QUESTION MARKS anywhere below: knex's `raw` treats every `?` as a
 * positional binding, comments included.
 */

export interface UnfulfilledColumns {
  /** SQL expression for pos_invoice.fulfillment_id. */
  fulfillmentId: string;
  /** SQL expression for fulfillment.canceled_at (NULL when the join missed). */
  canceledAt: string;
  /** SQL expression for fulfillment.shipped_at. */
  shippedAt: string;
  /** SQL expression for fulfillment.delivered_at. */
  deliveredAt: string;
  /** Boolean SQL expression: the fulfillment has at least one live label. */
  hasTracking: string;
  /** Boolean SQL expression: order_fulfillment links it to THIS invoice's order. */
  linkedToOrder: string;
}

/**
 * The EXISTS that proves the order can see this fulfillment.
 *
 * `invoiceAlias` must expose both `fulfillment_id` and `order_id` — pairing
 * them is the point: a link row for another order proves nothing here.
 */
export function linkedToOrderSql(invoiceAlias: string): string {
  return `EXISTS (
    SELECT 1
      FROM order_fulfillment ofl
     WHERE ofl.fulfillment_id = ${invoiceAlias}.fulfillment_id
       AND ofl.order_id = ${invoiceAlias}.order_id
       AND ofl.deleted_at IS NULL
  )`;
}

/** The predicate itself, as a boolean SQL expression. */
export function unfulfilledSql(c: UnfulfilledColumns): string {
  return `(
    ${c.fulfillmentId} IS NULL
    OR ${c.canceledAt} IS NOT NULL
    OR NOT ${c.linkedToOrder}
    OR (
      ${c.shippedAt} IS NULL
      AND ${c.deliveredAt} IS NULL
      AND NOT ${c.hasTracking}
    )
  )`;
}
