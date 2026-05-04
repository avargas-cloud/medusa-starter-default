import { ExecArgs } from "@medusajs/framework/types";
import { Client } from "pg";

import { syncAverageCostCore } from "../../../lib/quickbooks/sync-average-cost-core";

/**
 * Live average cost sync — calls syncAverageCostCore (same function as the API button).
 * Updates last_average_cost_sync in DB on success.
 *
 * Usage:
 *   npx medusa exec ./src/scripts/qb_sync/core_jobs/live-sync-average-cost.ts
 *
 * Dry run:
 *   DRY_RUN=true npx medusa exec ./src/scripts/qb_sync/core_jobs/live-sync-average-cost.ts
 */
export default async function liveSyncAverageCost({
  container,
  args,
}: ExecArgs) {
  const { ContainerRegistrationKeys } =
    await import("@medusajs/framework/utils");
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  const isDryRun =
    args?.includes("--dry-run") || process.env.DRY_RUN === "true";

  logger.info("=".repeat(60));
  logger.info(
    isDryRun
      ? "🔍 AVERAGE COST SYNC — DRY RUN (no writes)"
      : "🚀 LIVE AVERAGE COST SYNC — WRITING TO MEDUSA"
  );
  logger.info("Polling QB Bridge... may take 2-5 minutes.");
  logger.info("=".repeat(60));

  try {
    await client.connect();
    const result = await syncAverageCostCore(container, { dryRun: isDryRun });

    logger.info("\n" + "=".repeat(60));
    if (result.success) {
      logger.info(isDryRun ? "✅ DRY RUN COMPLETE" : "✅ LIVE SYNC COMPLETE");
      logger.info(
        `   Updated average cost: ${result.stats.updatedAverageCost ?? 0}`
      );
      logger.info(
        `   Skipped (no change):  ${result.stats.skippedNoChange ?? 0}`
      );
      logger.info(
        `   Skipped (no avg cost): ${result.stats.skippedNoAverageCost ?? 0}`
      );
      logger.info(`   Missing in QB:        ${result.stats.missingInQb ?? 0}`);
      logger.info(
        `   Meili reindexed:      ${result.stats.meiliReindexed ?? 0}`
      );

      if (!isDryRun) {
        await client.query(
          `UPDATE quickbooks_config SET last_average_cost_sync = NOW(), updated_at = NOW() WHERE id = 'default'`
        );
        logger.info("   ✅ last_average_cost_sync updated in DB");
      }
    } else {
      logger.error(`❌ Sync failed: ${result.error}`);
    }
    logger.info("=".repeat(60));
  } finally {
    await client.end();
  }
}
