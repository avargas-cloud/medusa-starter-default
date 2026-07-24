import { model } from "@medusajs/utils";

/**
 * QuickBooks Vendor Bill sync queue.
 *
 * One row per VendorBill (UNIQUE constraint on vendor_bill_id, partial —
 * WHERE deleted_at IS NULL). One-row-per-document, UPDATE-first convention
 * (2026-07-15 rule). Mirrors qb_purchase_order_pipeline's shape with the
 * extra fields the Bill flow needs (intent, snapshot, edit_sequence).
 *
 * Phase 0 (this table): schema only. No poller/dispatcher reads or writes
 * this table yet — it is fully dormant until the cron + routes land.
 *
 * Lifecycle (status):
 *   waiting          → ready for the cron poller
 *   submitted        → bridge accepted the op, awaiting QB Desktop response
 *   synced           → qb_txn_id populated, vendor_bill.qb_synced_at set
 *   error            → bridge/QB returned an error; retries per next_retry_at
 *   failed_permanent → retry budget exhausted; manual intervention required
 *
 * intent:
 *   add           → BillAdd (linked to PO — the create)
 *   mod           → BillMod (header/date/freight edits only — NOT relink)
 *   unlock_rebuild→ compound TxnDel Bill → PurchaseOrderMod → BillAdd
 *   void          → TxnDel Bill (cancellation / live-test cleanup)
 *
 * payload is a frozen snapshot of the bill header + lines at dispatch time —
 * retries always read from this column, never live tables. snapshot holds
 * the full pre-change bill payload, used by the unlock/repair path.
 *
 * Void lifecycle is parallel and independent of the add/mod lifecycle above,
 * mirroring qb_purchase_order_pipeline / qb_item_receipt_pipeline.
 */
export const QbVendorBillPipeline = model.define("qb_vendor_bill_pipeline", {
  id: model.id({ prefix: "qbvbpipe" }).primaryKey(),

  vendor_bill_id: model.text(),
  purchase_order_id: model.text().nullable(), // denormalized for admin views

  status: model.text().default("waiting"),
  intent: model.text().default("add"), // add | mod | unlock_rebuild | void

  // Bridge / QB identifiers
  qb_operation_id: model.text().nullable(),
  qb_txn_id: model.text().nullable(), // TxnID of the Bill in QB
  qb_ref_number: model.text().nullable(),

  // Frozen snapshot — single source of truth on retry
  payload: model.json(),
  // Full pre-change bill payload, used by the unlock/rebuild repair path
  snapshot: model.json().nullable(),
  edit_sequence: model.text().nullable(),

  // Bumped +1 by each delete+recreate (unlock rebuild). Feeds the generation-aware
  // Idempotency-Key `vendor-bill:<id>:g<n>` so a rebuild BillAdd is never dedupe-
  // suppressed by the bridge while a same-generation re-dispatch still is.
  rebuild_generation: model.number().default(0),

  retries: model.number().default(0),
  next_retry_at: model.dateTime().nullable(),
  synced_at: model.dateTime().nullable(),
  last_error: model.text().nullable(),

  // Void lifecycle (independent of add/mod)
  void_status: model.text().nullable(),
  void_operation_id: model.text().nullable(),
  void_last_error: model.text().nullable(),
  void_retries: model.number().default(0),
  void_next_retry_at: model.dateTime().nullable(),
});
