/**
 * src/jobs/qb-reverse-void-monitor.ts
 *
 * Daily sweep of the direction `qb-void-reconciler` cannot see: documents
 * alive (and often paid) in the POS whose QuickBooks document was voided or
 * deleted outside the pipeline. Reads QuickBooks in 4 batched bridge ops and
 * upserts findings into `qb_reverse_void_finding`; the daily digest reports
 * open findings until a human resolves them. Never repairs anything.
 *
 * Scheduled an hour before the digest so a fresh sweep is what gets reported.
 */
import { MedusaContainer } from "@medusajs/framework/types";

import { getDbPool } from "../api/utils/db-pool";
import { runReverseVoidSweep } from "../lib/quickbooks/reverse-void-sweep";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";

const TAG = "[qb-reverse-void-monitor]";

export default async function qbReverseVoidMonitor(container: MedusaContainer) {
  if (isScheduledJobsDisabled(container)) return;

  const logger = container.resolve("logger") as {
    info: (m: string) => void;
    warn: (m: string) => void;
  };

  try {
    const summary = await runReverseVoidSweep(getDbPool(), logger);
    if (summary.findings > 0) {
      logger.warn(
        `${TAG} ${summary.findings} POS-alive document(s) whose QB doc is gone ` +
          `(${summary.inserted} new) — see tomorrow's digest / qb_reverse_void_finding`
      );
    }
  } catch (err) {
    // A bridge outage must not look like a clean sweep — but it also must not
    // crash the job runner. Warn loudly; tomorrow's run covers the gap (the
    // deleted/modified windows overlap by construction).
    logger.warn(
      `${TAG} sweep failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export const config = {
  name: "qb-reverse-void-monitor",
  schedule: "0 23 * * *",
};
