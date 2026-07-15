import { model } from "@medusajs/utils";

/**
 * Tracks the QuickBooks sync state of every product variant operation
 * (add OR mod) emitted from the POS toward QuickBooks Desktop.
 *
 * Lifecycle:
 *   waiting          → bridge operation queued, polling for ListID/result
 *   synced           → qb_list_id populated; variant.metadata in sync with QB
 *   error            → bridge or QB returned an error; auto-retry pending
 *                       (next_retry_at set, retries < MAX)
 *   failed_permanent → MAX retries exhausted; only manual Retry can revive
 *
 * Used by the order pipeline to gate QB order sync: orders cannot sync to QB
 * until ALL of their variants have status=synced.
 */
export const QbItemPipeline = model.define("qb_item_pipeline", {
  id: model.id({ prefix: "qbitp" }).primaryKey(),
  seq: model.number().nullable(), // DB BIGSERIAL auto-generated — do not pass on insert
  variant_id: model.text(), // Medusa product_variant.id
  sku: model.text(),
  op_action: model.text().default("add"), // 'add' | 'mod'
  op_payload: model.json().nullable(), // bridge body for faithful retry
  qb_id: model.text().nullable(), // ListID for 'mod' (denormalized)
  qb_operation_id: model.text().nullable(), // operationId returned by bridge
  qb_list_id: model.text().nullable(), // ListID once resolved
  qb_edit_sequence: model.text().nullable(),
  item_type: model.text().default("Inventory"), // Inventory | Service | NonInventory
  status: model.text().default("waiting"), // waiting | synced | error | failed_permanent
  last_error: model.text().nullable(),
  last_error_code: model.text().nullable(), // structured QB/bridge error code (e.g. "3200")
  retries: model.number().default(0), // increments on resubmit FAILURE only
  // Recovery state lives in a SCALAR column, never in op_payload: a scalar update
  // replaces (no JSONB deep-merge), so it can't get stuck "on" the way the old
  // __iq_pending/__iq_reconcile JSON markers did (seq 120 incident, 2026-05-29).
  recovery_mode: model.text().default("none"), // none | editseq_query | reconcile_query
  // submit_count increments on EVERY bridge dispatch (success OR failure), unlike
  // retries. It's the only signal that catches a row that resubmits successfully
  // each tick but never completes (retries stays 0). A hard cap demotes it.
  submit_count: model.number().default(0),
  last_submitted_at: model.dateTime().nullable(),
  next_retry_at: model.dateTime().nullable(),
  failed_at: model.dateTime().nullable(),
  resolved_at: model.dateTime().nullable(),
  // Stamped by qb-pipeline-error-digest.ts when it reports this row in the
  // STUCK bucket — lets that bucket dedupe (don't repeat the same still-broken
  // row every day; only re-surface on a new development or a weekly safety net).
  digest_notified_at: model.dateTime().nullable(),
});
