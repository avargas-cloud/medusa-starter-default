import { model } from "@medusajs/utils";

/**
 * QuickBooks InventoryAdjustment sync queue.
 *
 * One row per (inventory_count, qb_account_list_id) combination — a single
 * count whose lines reference multiple accounts produces multiple pipeline
 * rows (and therefore multiple QB InventoryAdjustmentAdd transactions).
 *
 * Lifecycle:
 *   waiting    → ready for the cron poller to pick up
 *   processing → bridge accepted the operation, awaiting QB Desktop response
 *   synced     → qb_list_id populated, count.qb_synced_at set
 *   error      → bridge or QB returned an error; will retry per next_retry_at
 *   cancelled  → manager voided the count after partial sync
 *
 * payload is an immutable snapshot of the lines as they were at approval
 * time — retries always read from this column, never from the live tables.
 */
export const QbInventoryAdjustmentPipeline = model.define(
  "qb_inventory_adjustment_pipeline",
  {
    id: model.id({ prefix: "qbinvadj" }).primaryKey(),
    seq: model.number(), // Short sequential reference id — DB BIGSERIAL

    inventory_count_id: model.text(),
    qb_account_list_id: model.text(),

    status: model.text().default("waiting"),

    // Bridge / QB identifiers
    qb_operation_id: model.text().nullable(),
    qb_list_id: model.text().nullable(), // TxnID of the InventoryAdjustment in QB
    qb_txn_number: model.text().nullable(),

    // Frozen snapshot — the only source of truth on retry
    payload: model.json(),

    last_error: model.text().nullable(),
    retries: model.number().default(0),
    next_retry_at: model.dateTime().nullable(),
    synced_at: model.dateTime().nullable(),

    // Void lifecycle (independent of the add lifecycle above):
    //   void_status: null → 'waiting' → 'processing' → 'voided' (or 'error')
    // Triggered when the manager voids a previously-synced count.
    void_status: model.text().nullable(),
    void_operation_id: model.text().nullable(),
    void_synced_at: model.dateTime().nullable(),
    void_last_error: model.text().nullable(),
    void_retries: model.number().default(0),
    void_next_retry_at: model.dateTime().nullable(),
  }
);
