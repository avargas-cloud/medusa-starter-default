import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { reconcileCustomersCore } from "../../../../../../lib/quickbooks/reconcile-customers-core";
import {
  createSyncJob,
  appendLog,
  finishJob,
} from "../../../../../../lib/quickbooks/sync-jobs";

/**
 * Executes the Customer ID Reconciliation process as an async Job.
 *
 * Supports dry_run mode to preview matches without changing Medusa DB.
 */
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { dry_run = false } = req.body as { dry_run?: boolean };

  const job = createSyncJob("customers");
  appendLog(job, `Started Customer Reconciliation (Dry Run: ${dry_run})...`);

  // Fire and forget
  (async () => {
    try {
      appendLog(job, "Initializing Quickbooks Bridge Connection...");

      const result = await reconcileCustomersCore(req.scope, {
        dryRun: dry_run,
        onLog: (msg) => {
          appendLog(job, msg);
        },
      });

      if (result.success) {
        appendLog(job, "✅ Reconciliation completed successfully.");
        finishJob(job, "done");
      } else {
        appendLog(job, `❌ ${result.error || "Unknown reconciliation error"}`);
        finishJob(job, "error");
      }
    } catch (error: any) {
      appendLog(job, `❌ Fatal error: ${error.message}`);
      finishJob(job, "error");
    }
  })();

  res.json({ success: true, job_id: job.id });
}
