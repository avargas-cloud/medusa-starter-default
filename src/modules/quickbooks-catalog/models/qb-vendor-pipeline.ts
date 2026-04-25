import { model } from "@medusajs/utils";

/**
 * Observability trail for QuickBooks vendor create/update ops.
 *
 * One row per bridge dispatch. Mirrors the qb_item_pipeline pattern so the
 * admin "QB Pipeline" view can render vendor ops in its own tab without
 * polluting the order operations pipeline (which models a multi-step chain).
 *
 * Lifecycle:
 *   waiting → bridge op dispatched, polling for ListID
 *   synced  → qb_list_id populated
 *   error   → bridge returned failed or polling timed out (will be retried)
 */
export const QbVendorPipeline = model.define("qb_vendor_pipeline", {
  id: model.id({ prefix: "qbvndp" }).primaryKey(),
  seq: model.number().nullable(), // DB BIGSERIAL auto-generated — do not pass on insert
  vendor_id: model.text(), // qb_vendor.id this row tracks
  vendor_name: model.text(), // snapshot of full_name at dispatch time
  op_type: model.text().default("create"), // create | update
  qb_operation_id: model.text().nullable(),
  qb_list_id: model.text().nullable(),
  status: model.text().default("waiting"), // waiting | synced | error
  last_error: model.text().nullable(),
  retries: model.number().default(0),
  resolved_at: model.dateTime().nullable(),
});
