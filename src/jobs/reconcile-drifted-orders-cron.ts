import type { MedusaContainer } from "@medusajs/framework/types";

import reconcileAndCloseDrifted from "../scripts/fix/reconcile-and-close-drifted-orders";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";
/**
 * Scheduled self-heal for orders stuck `pending` because a void+re-fulfill / edit
 * drifted the current-version fulfilled_quantity below quantity even though the
 * goods shipped. Runs the conservative, proof-required reconciler (see
 * scripts/fix/reconcile-and-close-drifted-orders.ts): only acts on orders that
 * are fully invoiced + fully paid, were fully fulfilled in a PRIOR version, and
 * have been stale > STALE_HOURS (default 24h) — so it never catches an order
 * mid void→re-fulfill correction.
 *
 * Kill switch: set RECONCILE_DRIFT_CRON_ENABLED=false to disable without a deploy.
 */
export default async function reconcileDriftedOrdersCron(
  container: MedusaContainer
): Promise<void> {
  if (isScheduledJobsDisabled(container)) return;

  if (process.env.RECONCILE_DRIFT_CRON_ENABLED === "false") return;
  const logger = container.resolve("logger") as any;
  try {
    await reconcileAndCloseDrifted({ container });
  } catch (err: any) {
    logger.warn(
      `[reconcile-drifted-orders] cron run failed (non-fatal): ${err?.message}`
    );
  }
}

export const config = {
  name: "reconcile-drifted-orders",
  schedule: "0 */6 * * *", // every 6 hours
};
