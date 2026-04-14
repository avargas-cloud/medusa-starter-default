import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { syncCustomersCore } from "../../../../../lib/quickbooks/sync-customers-core";
import {
  createSyncJob,
  appendLog,
  finishJob,
} from "../../../../../lib/quickbooks/sync-jobs";
import { QbSyncLogger } from "../../../../../lib/quickbooks/qb-sync-logger";
import { Client } from "pg";

/**
 * POST /admin/quickbooks/sync/customers
 * Returns {started, job_id} immediately — sync streams logs via SSE.
 * Also logs to Activity Log (qb_sync_log) for visibility in QB admin panel.
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const job = createSyncJob("customers");

  res.json({
    success: true,
    started: true,
    job_id: job.id,
    message:
      "Customer sync started — stream logs at /admin/quickbooks/sync/stream?job_id=" +
      job.id,
  });

  setImmediate(async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    let logId: string | undefined;
    try {
      await client.connect();
      appendLog(job, "🚀 Customer sync started...");

      // Create Activity Log entry before starting
      logId = await QbSyncLogger.start({
        operation: "customer_sync",
        syncType: "customer",
        triggeredBy: "manual",
        message: "Customer sync started (manual)",
        db: client,
      });

      const result = await syncCustomersCore(req.scope, {
        onLog: (line) => appendLog(job, line),
      });

      if (result.success) {
        const msg = `Done: ${result.stats?.imported ?? 0} imported, ${result.stats?.alreadyInMedusa ?? 0} already existed`;
        appendLog(job, `✅ ${msg}`);
        await client
          .query(
            `UPDATE quickbooks_config SET last_customer_sync = NOW(), updated_at = NOW() WHERE id = 'default'`
          )
          .catch((err: any) =>
            appendLog(
              job,
              `⚠️ Could not update last_customer_sync: ${err.message}`
            )
          );
        await QbSyncLogger.complete(logId, { message: msg, db: client });
        finishJob(job, "done");
      } else {
        appendLog(job, `❌ Sync failed: ${result.error}`);
        await QbSyncLogger.fail(logId, result.error || "Unknown error", {
          db: client,
        });
        finishJob(job, "error");
      }
    } catch (error: any) {
      appendLog(job, `❌ Error: ${error.message}`);
      if (logId) {
        await QbSyncLogger.fail(logId, error.message, { db: client }).catch(
          () => {}
        );
      }
      finishJob(job, "error");
    } finally {
      await client.end();
    }
  });
}
