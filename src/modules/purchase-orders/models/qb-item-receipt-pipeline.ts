import { model } from "@medusajs/utils";

/**
 * QuickBooks ItemReceipt sync queue.
 *
 * One row per PurchaseOrderReceipt (UNIQUE constraint on
 * purchase_order_receipt_id). Triggered when the receipt is created and
 * stock has been successfully applied in Medusa.
 *
 * Lifecycle:
 *   waiting    → ready for the cron poller
 *   processing → bridge accepted the op, awaiting QB Desktop response
 *   synced     → qb_list_id populated, receipt.qb_synced_at set
 *   error      → bridge/QB returned an error; retries per next_retry_at
 *   cancelled  → receipt voided before sync completed
 *
 * ItemReceipt semantics in QB: ItemReceiptAdd increases stock in QB AND
 * creates an accounts-payable entry against the vendor. This is the
 * canonical "received merchandise, bill not yet processed" transaction.
 *
 * payload is frozen — contains vendor ref, receipt metadata, and line
 * array with sku + qty + unit cost. Retries never read from live tables.
 */
export const QbItemReceiptPipeline = model.define("qb_item_receipt_pipeline", {
  id: model.id({ prefix: "qbrcpipe" }).primaryKey(),
  // seq is a DB BIGSERIAL (nextval) — not declared here so MikroORM omits it
  // from INSERTs and lets the DB auto-generate it.

  purchase_order_receipt_id: model.text(),
  purchase_order_id: model.text(), // denormalized for admin views

  status: model.text().default("waiting"),

  // Bridge / QB identifiers
  qb_operation_id: model.text().nullable(),
  qb_list_id: model.text().nullable(), // TxnID of the ItemReceipt in QB
  qb_txn_number: model.text().nullable(),

  // Frozen snapshot — single source of truth on retry
  payload: model.json(),

  last_error: model.text().nullable(),
  retries: model.number().default(0),
  next_retry_at: model.dateTime().nullable(),
  synced_at: model.dateTime().nullable(),

  // Void lifecycle (independent of add)
  void_status: model.text().nullable(),
  void_operation_id: model.text().nullable(),
  void_synced_at: model.dateTime().nullable(),
  void_last_error: model.text().nullable(),
  void_retries: model.number().default(0),
  void_next_retry_at: model.dateTime().nullable(),
});
