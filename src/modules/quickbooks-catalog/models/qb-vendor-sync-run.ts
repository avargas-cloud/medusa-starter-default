import { model } from "@medusajs/utils";

/**
 * Tracks a single mass pull from QuickBooks Vendor catalog.
 * Durable so a backend restart doesn't lose the in-flight sync.
 *
 * State machine:
 *   queued     → enqueued by user click; runner hasn't touched yet
 *   fetching   → runner dispatched bridge VendorQuery op; polling for result
 *   processing → bridge returned vendor_snapshot; runner upserting chunks
 *   completed  → processed_count == total_count
 *   failed     → fatal error; see last_error
 *   cancelled  → user clicked Cancel before completion
 */
export const QbVendorSyncRun = model.define("qb_vendor_sync_run", {
  id: model.id({ prefix: "qbvsr" }).primaryKey(),
  status: model.text().default("queued"),
  bridge_operation_id: model.text().nullable(),
  vendor_snapshot: model.json().nullable(), // array of VendorRet between fetch and process
  total_count: model.number().default(0),
  processed_count: model.number().default(0),
  created_count: model.number().default(0),
  updated_count: model.number().default(0),
  error_count: model.number().default(0),
  started_at: model.dateTime().nullable(),
  completed_at: model.dateTime().nullable(),
  last_error: model.text().nullable(),
  triggered_by_user_id: model.text().nullable(),
});
