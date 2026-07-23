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
  /**
   * full          → refresh every vendor field from QB (the /vendors page button)
   * payment_terms → only refresh the QB payment term + its due-days
   *                 (Settings → QuickBooks Sync → "Resync Payment Terms")
   */
  mode: model.text().default("full"),
  bridge_operation_id: model.text().nullable(),
  /** Bridge op id of the parallel QB Terms query (name → StdDueDays). */
  terms_operation_id: model.text().nullable(),
  vendor_snapshot: model.json().nullable(), // array of VendorRet between fetch and process
  terms_snapshot: model.json().nullable(), // QbTermsMap between fetch and process
  total_count: model.number().default(0),
  processed_count: model.number().default(0),
  created_count: model.number().default(0),
  updated_count: model.number().default(0),
  /** Vendors whose default_payment_terms_days was written from QB. */
  terms_written_count: model.number().default(0),
  /** Vendors left alone: no term in QB, or a manual POS override is in place. */
  terms_skipped_count: model.number().default(0),
  error_count: model.number().default(0),
  started_at: model.dateTime().nullable(),
  completed_at: model.dateTime().nullable(),
  last_error: model.text().nullable(),
  triggered_by_user_id: model.text().nullable(),
});
