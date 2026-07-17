import { model } from "@medusajs/utils";

/**
 * qb_avg_cost_sync_run — durable tracking table for a manual "SYNC NOW" pull of
 * QuickBooks AverageCost into product_variant.metadata.qb_avg_cost.
 *
 * Mirrors the qb_vendor_sync_run pattern so the POS QuickBooks Tools "Cost Sync"
 * tab can poll a structured progress row (badge + bar + N/M counter + stats)
 * with Bearer auth — no SSE (native EventSource can't attach Authorization).
 *
 * Unlike the vendor sync, the work is driven inline via setImmediate in the POST
 * route (not a cron runner), so there is no bridge_operation_id / snapshot to
 * persist — the whole run completes in one process. A stale-run guard in the
 * route treats a heartbeat-less active run as failed so the button never wedges.
 *
 * scope:
 *   non_china → only variants whose product is NOT sourced via agent
 *               (product.metadata.is_sourced_via_agent IS DISTINCT FROM 'true')
 *   all       → every QB-linked variant (parity with the scheduled cron)
 *
 * State machine:
 *   queued     → enqueued by user click
 *   fetching   → pulling AverageCost from the QB bridge (slow phase)
 *   processing → matching + writing qb_avg_cost per chunk
 *   completed  → finished; see updated/unchanged/skipped counts
 *   failed     → fatal error; see last_error
 */
export const QbAvgCostSyncRun = model.define("qb_avg_cost_sync_run", {
  id: model.id({ prefix: "qbacsr" }).primaryKey(),
  status: model.text().default("queued"),
  scope: model.text().default("non_china"),
  total_count: model.number().default(0),
  processed_count: model.number().default(0),
  updated_count: model.number().default(0),
  unchanged_count: model.number().default(0),
  skipped_count: model.number().default(0),
  error_count: model.number().default(0),
  started_at: model.dateTime().nullable(),
  completed_at: model.dateTime().nullable(),
  last_error: model.text().nullable(),
  triggered_by_user_id: model.text().nullable(),
});
