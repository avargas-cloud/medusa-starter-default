/**
 * Purchasing snapshot cron — runs daily at 12:00 AM.
 * Recalculates daily sales estimates, ABC-XYZ classes, and reorder quantities
 * for all active variants and writes them to purchasing_snapshot.
 */

import type { MedusaContainer } from "@medusajs/framework/types";

import { runPurchasingSnapshot } from "../services/purchasing/snapshot.service";

export const config = {
  name: "purchasing-snapshot-daily",
  schedule: "0 0 * * *",
};

export default async function purchasingSnapshotCron(
  _container: MedusaContainer
) {
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
