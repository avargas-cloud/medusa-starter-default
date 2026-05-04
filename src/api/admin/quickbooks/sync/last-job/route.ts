import { MedusaRequest, MedusaResponse } from "@medusajs/framework";

import {
  getLastJobByType,
  loadPersistedReport,
  SyncType,
} from "../../../../../lib/quickbooks/sync-jobs";

/**
 * GET /admin/quickbooks/sync/last-job?type=inventory|prices|average-cost|customers
 *
 * Returns the last job_id + status for a given sync type.
 * Checks in-memory first, then falls back to disk-persisted report.
 * Used by the frontend on page load to restore "View Report" state.
 */
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const type = req.query.type as SyncType | undefined;

  if (
    !type ||
    !["inventory", "prices", "average-cost", "customers", "reconcile"].includes(
      type
    )
  ) {
    res
      .status(400)
      .json({
        error:
          "type must be inventory | prices | average-cost | customers | reconcile",
      });
    return;
  }

  // 1. Check in-memory
  const job = getLastJobByType(type);
  if (job) {
    res.json({
      job_id: job.id,
      status: job.status,
      log_count: job.logs.length,
      started_at: job.startedAt,
      finished_at: job.finishedAt ?? null,
      source: "memory",
    });
    return;
  }

  // 2. Fall back to disk (survives server restarts)
  const report = loadPersistedReport(type);
  if (report) {
    res.json({
      job_id: report.id,
      status: report.status,
      log_count: report.logs.length,
      started_at: report.startedAt,
      finished_at: report.finishedAt,
      source: "disk",
    });
    return;
  }

  // 3. No report at all
  res.json({ job_id: null, status: null, log_count: 0, source: "none" });
}
