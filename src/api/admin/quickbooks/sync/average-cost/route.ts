import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaContainer } from "@medusajs/framework/types";
import { Client } from "pg";

import { QbSyncLogger } from "../../../../../lib/quickbooks/qb-sync-logger";
import {
  appendLog,
  createSyncJob,
  finishJob,
} from "../../../../../lib/quickbooks/sync-jobs";
import { syncAverageCostCore } from "../../../../../lib/quickbooks/sync-average-cost-core";

/**
 * POST /admin/quickbooks/sync/average-cost
 * Returns {started, job_id} immediately — sync streams logs via SSE.
 * Body: { dry_run?: boolean }
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const container = req.scope as MedusaContainer;
  const dryRun = !!(req.body as { dry_run?: boolean } | undefined)?.dry_run;
  const job = createSyncJob("average-cost");

  res.json({
    success: true,
    started: true,
    dryRun,
    job_id: job.id,
    message:
      "Average cost sync started — stream logs at /admin/quickbooks/sync/stream?job_id=" +
      job.id,
  });

  setImmediate(async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    let logId: string | undefined;

    try {
      await client.connect();
      appendLog(job, "🚀 Average cost sync started...");

      logId = await QbSyncLogger.start({
        operation: "average_cost_sync",
        syncType: "average_cost",
        triggeredBy: "manual",
        message: `Average cost sync started (manual${dryRun ? " — dry run" : ""})`,
        db: client,
      });

      const result = await syncAverageCostCore(container, {
        dryRun,
        onLog: (line) => appendLog(job, line),
      });

      if (result.success) {
        const msg = `Done: ${result.stats.updatedAverageCost} average costs updated`;
        appendLog(job, `✅ ${msg}`);
        if (!dryRun) {
          await client.query(
            `UPDATE quickbooks_config SET last_average_cost_sync = NOW(), updated_at = NOW() WHERE id = 'default'`
          );
        }
        await QbSyncLogger.complete(logId, { message: msg, db: client });
        finishJob(job, "done");
      } else {
        appendLog(job, `❌ Sync failed: ${result.error}`);
        await QbSyncLogger.fail(logId, result.error || "Unknown error", {
          db: client,
        });
        finishJob(job, "error");
      }
    } catch (error) {
      const message = (error as Error).message;
      appendLog(job, `❌ Error: ${message}`);
      if (logId) {
        await QbSyncLogger.fail(logId, message, { db: client }).catch(
          () => {}
        );
      }
      finishJob(job, "error");
    } finally {
      await client.end();
    }
  });
}
