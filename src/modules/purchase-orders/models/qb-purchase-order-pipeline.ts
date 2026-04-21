import { model } from "@medusajs/utils";

/**
 * QuickBooks PurchaseOrder sync queue.
 *
 * One row per purchase order (UNIQUE constraint on purchase_order_id).
 * Triggered when the PO status flips from 'draft' to 'submitted'.
 *
 * Lifecycle:
 *   waiting    → ready for the cron poller to pick up
 *   processing → bridge accepted the operation, awaiting QB Desktop response
 *   synced     → qb_list_id populated, po.qb_synced_at set
 *   error      → bridge or QB returned an error; will retry per next_retry_at
 *   cancelled  → PO cancelled or voided before sync completed
 *
 * payload is a frozen snapshot of the PO header + lines at submit time —
 * retries always read from this column, never from the live tables.
 *
 * Void lifecycle is parallel: when the PO is voided after sync, void_status
 * tracks the QB TxnVoid request independently.
 */
export const QbPurchaseOrderPipeline = model.define(
  "qb_purchase_order_pipeline",
  {
    id: model.id({ prefix: "qbpopipe" }).primaryKey(),

    purchase_order_id: model.text(),

    status: model.text().default("waiting"),

    // Bridge / QB identifiers
    qb_operation_id: model.text().nullable(),
    qb_list_id: model.text().nullable(), // TxnID of the PurchaseOrder in QB
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
  }
);
