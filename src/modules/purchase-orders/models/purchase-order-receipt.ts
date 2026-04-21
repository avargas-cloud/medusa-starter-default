import { model } from "@medusajs/utils";

/**
 * A physical receipt event against a purchase order.
 *
 * One PO can be received in multiple shipments — each reception = one
 * PurchaseOrderReceipt row + N PurchaseOrderReceiptLine rows. The sum of
 * receipt_line.qty_received_now across all non-voided receipts is what
 * fills PurchaseOrderLine.qty_received.
 *
 * Lifecycle:
 *   pending  → stock apply in progress (transient; should be brief)
 *   applied  → Medusa stock updated; QB ItemReceiptAdd enqueued
 *   synced   → QB ItemReceiptAdd confirmed; qb_item_receipt_list_id populated
 *   voided   → receipt reversed; stock contra-applied + QB TxnVoid queued
 *   error    → stock apply failed; admin resolves manually
 *
 * Numbering: RCP-{seq} allocated from `custom_po_receipt_seq` at creation.
 * stock_location_id defaults to the PO header's location but may differ
 * if the shipment was redirected at the last minute.
 */
export const PurchaseOrderReceipt = model.define("purchase_order_receipt", {
  id: model.id({ prefix: "por" }).primaryKey(),

  purchase_order_id: model.text(),

  // Numbering — RCP-{seq}
  number: model.text(),
  seq: model.number(),

  status: model.text().default("pending"),

  // Physical receipt metadata
  received_at: model.dateTime(),
  received_by_user_id: model.text(),
  stock_location_id: model.text(),

  // Optional vendor document references
  vendor_bill_number: model.text().nullable(),
  vendor_bill_date: model.dateTime().nullable(),

  // Free-text
  notes: model.text().nullable(),

  // QB sync — ItemReceiptAdd
  qb_item_receipt_list_id: model.text().nullable(), // TxnID
  qb_item_receipt_txn_number: model.text().nullable(),
  qb_synced_at: model.dateTime().nullable(),

  // Void lifecycle (independent of the add lifecycle)
  voided_at: model.dateTime().nullable(),
  voided_by_user_id: model.text().nullable(),
  void_reason: model.text().nullable(),
  qb_void_list_id: model.text().nullable(), // TxnID of the void transaction
  qb_void_synced_at: model.dateTime().nullable(),
});
