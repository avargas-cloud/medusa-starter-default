import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import qbVendorSyncRunner from "../../../../../../jobs/qb-vendor-sync-runner";

/**
 * POST /admin/qb-catalog/vendors/sync/run-now
 * Manually invoke the vendor sync runner. Useful if the cron scheduler
 * is unreachable (dev restart churn) or to force-advance a stuck run.
 *
 * Does NOT enqueue a new run — just drives the existing active run one tick.
 * Returns the fresh state after the tick.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve("logger");
  try {
    await qbVendorSyncRunner(req.scope as any);
    logger.info(`[qb-vendor-sync-runner] manual run-now tick completed`);

    const query = req.scope.resolve("query");
    const { data } = await query.graph({
      entity: "qb_vendor_sync_run",
      fields: [
        "id",
        "status",
        "total_count",
        "processed_count",
        "created_count",
        "updated_count",
        "error_count",
        "started_at",
        "completed_at",
        "last_error",
        "created_at",
      ],
      pagination: { skip: 0, take: 1 },
    });
    const all = data as any[];
    const sorted = all.sort((a, b) => {
      const ta = new Date(a.created_at ?? 0).getTime();
      const tb = new Date(b.created_at ?? 0).getTime();
      return tb - ta;
    });
    return res.json({ success: true, run: sorted[0] ?? null });
  } catch (err: any) {
    logger.error(`[qb-vendor-sync-runner] manual run-now failed: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
};
