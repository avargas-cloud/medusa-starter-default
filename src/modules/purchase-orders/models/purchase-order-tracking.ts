import { model } from "@medusajs/utils";

/**
 * One inbound SHIPMENT on a purchase order — a delivery of goods travelling
 * FROM the vendor.
 *
 * A shipment is the unit that says WHAT is arriving. The carrier tracking
 * numbers hang off it (purchase_order_tracking_number), because one delivery
 * routinely produces several: two FedEx waybills for the same truck are two
 * numbers for ONE arrival, not two competing claims. The first number is the
 * master.
 *
 * `scope` is what makes per-product ETA possible:
 *
 *   all_order → everything on this PO travels in this shipment.
 *   by_line   → this shipment carries specific quantities of specific PO lines,
 *               enumerated in purchase_order_tracking_line.
 *
 * A PO IS EITHER COVERED BY ONE WHOLE-PO SHIPMENT OR BROKEN OUT PER ITEM.
 * Never both, and never two whole-PO shipments — two deliveries cannot each
 * contain all of the goods. When a whole-PO shipment turns out to have been
 * partial, the fix is to EDIT it and mark what actually arrived; that converts
 * it to `by_line` and frees the rest for the next shipment. Splitting is a
 * correction of the first delivery, never an addition beside it. Enforced in
 * _lib/tracking-writes.ts on the resulting state.
 *
 * Local-only: inbound logistics never sync to QuickBooks.
 *
 * Replaces the `purchase_order.tracking` JSON column, which is kept (frozen,
 * no dual-write) for one release as the rollback path.
 */
export const PurchaseOrderTracking = model.define("purchase_order_tracking", {
  id: model.id({ prefix: "potrk" }).primaryKey(),

  purchase_order_id: model.text(),

  /** "all_order" | "by_line" — see the note above on mutual exclusion. */
  scope: model.text().default("all_order"),

  created_by_user_id: model.text().nullable(),
  updated_by_user_id: model.text().nullable(),
});
