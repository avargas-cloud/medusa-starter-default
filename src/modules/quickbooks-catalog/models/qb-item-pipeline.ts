import { model } from "@medusajs/utils";

/**
 * Tracks the QuickBooks sync state of each product variant created via the POS.
 *
 * Lifecycle:
 *   waiting  → bridge operation queued, polling for ListID response
 *   synced   → qb_list_id populated and variant.metadata.quickbooks_id updated
 *   error    → QB returned an error; admin can retry or assign qb_list_id manually
 *
 * Used by the order pipeline to gate QB order sync: orders cannot sync to QB
 * until ALL of their variants have status=synced.
 */
export const QbItemPipeline = model.define("qb_item_pipeline", {
  id: model.id({ prefix: "qbitp" }).primaryKey(),
  variant_id: model.text(), // Medusa product_variant.id
  sku: model.text(),
  qb_operation_id: model.text().nullable(), // operationId returned by the bridge
  qb_list_id: model.text().nullable(), // ListID once resolved
  qb_edit_sequence: model.text().nullable(),
  item_type: model.text().default("Inventory"), // Inventory | Service | NonInventory
  status: model.text().default("waiting"), // waiting | synced | error
  last_error: model.text().nullable(),
  retries: model.number().default(0),
  resolved_at: model.dateTime().nullable(),
});
