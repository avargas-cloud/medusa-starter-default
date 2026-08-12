/**
 * Purchasing snapshot cron — every 4 hours (was daily at 12:00 AM; bumped
 * 2026-08-11 when the PO item table started rendering Transfer columns, so the
 * demand-rate half of the feed stays same-day fresh — the smart-skip upsert
 * makes a no-op run near-instant, same trade as the PO-tracking ETA cron).
 * Recalculates daily sales estimates, ABC-XYZ classes, and reorder quantities
 * for all active variants and writes them to purchasing_snapshot. Inventory,
 * reservations and on-PO quantities are NOT here — the snapshot route reads
 * those live on every GET.
 */

import type { MedusaContainer } from "@medusajs/framework/types";

import { runPurchasingSnapshot } from "../services/purchasing/snapshot.service";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";
export const config = {
  name: "purchasing-snapshot-daily",
  schedule: "0 */4 * * *",
};

export default async function purchasingSnapshotCron(
  _container: MedusaContainer
) {
  if (isScheduledJobsDisabled(_container)) return;

  const logger = console;
  logger.info("[purchasing-cron] Starting daily snapshot...");

  try {
    const result = await runPurchasingSnapshot();
    logger.info(
      `[purchasing-cron] ✓ Snapshot complete — ${result.processed} variants, ${result.errors} errors, ${result.durationMs}ms`
    );
  } catch (e) {
    logger.error(
      `[purchasing-cron] ✗ Snapshot failed: ${(e as Error).message}`
    );
  }
}
