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
  seq: model.number(), // Short sequential reference id (1, 2, 3, ...) — DB BIGSERIAL
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
  retries: model.number().default(0),
  next_retry_at: model.dateTime().nullable(),
  failed_at: model.dateTime().nullable(),
  resolved_at: model.dateTime().nullable(),
});
