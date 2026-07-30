import { model } from "@medusajs/utils";

/**
 * How much of one PO line travels in one tracking number.
 *
 * A PO line ordered 100 can split 40 / 60 across two shipments, so the link
 * between a tracking number and a PO line carries a quantity — this is a
 * many-to-many WITH a number on it, which is why it is a table and not a key
 * inside the tracking JSON.
 *
 * IDENTITY IS ALWAYS purchase_order_line_id, NEVER the SKU. A single PO may
 * carry the same SKU on two separate lines, so any attempt to resolve an
 * allocation back by SKU is ambiguous by construction.
 *
 * THE CAP
 * Across sibling trackings of the same PO, the sum of qty_allocated for a line
 * may not exceed `qty_ordered - qty_cancelled` of that line. Cancelled units
 * are no longer shippable, so they leave the ceiling. `qty_received` is NOT
 * subtracted: a unit that already arrived still belongs, historically, to the
 * tracking number that carried it — subtracting it would make the allocation
 * evaporate the moment the goods land.
 *
 * `all_order` trackings contribute nothing to that sum (see the model note on
 * purchase-order-tracking.ts).
 *
 * The cap is enforced in the service layer inside a transaction, because a
 * DB constraint cannot express a sum across sibling rows. Uniqueness of
 * (tracking, line) and positivity of the quantity ARE constraints — see the
 * migration.
 *
 * SCOPE: quantities only. Nothing here consumes receipts, touches inventory or
 * knows about QuickBooks. Which allocation is still in transit after a partial
 * receive is a separate question this table deliberately does not answer yet.
 */
export const PurchaseOrderTrackingLine = model.define(
  "purchase_order_tracking_line",
  {
    id: model.id({ prefix: "potrkl" }).primaryKey(),

    purchase_order_tracking_id: model.text(),
    purchase_order_line_id: model.text(),
    purchase_order_id: model.text(), // denormalized for query convenience

    /** Units of that PO line carried by this tracking number. Always > 0. */
    qty_allocated: model.number(),
  }
);
