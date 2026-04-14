import { ExecArgs } from "@medusajs/framework/types";
import { syncPricesCore } from "../../../lib/quickbooks/sync-prices-core";
import { Client } from "pg";

/**
 * Live price sync — calls syncPricesCore (same function as the API Sync Now button).
 * Updates last_price_sync in DB on success.
 *
 * Usage:
 *   npx medusa exec src/scripts/sync/live-sync-prices.ts
 *
 * Add --dry-run to preview without writing:
 *   DRY_RUN=true npx medusa exec src/scripts/sync/live-sync-prices.ts
 */
export default async function liveSyncPrices({ container, args }: ExecArgs) {
  const { ContainerRegistrationKeys } =
    await import("@medusajs/framework/utils");
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  const isDryRun =
    args?.includes("--dry-run") || process.env.DRY_RUN === "true";

  logger.info("=".repeat(60));
  logger.info(
    isDryRun
      ? "🔍 PRICE SYNC — DRY RUN (no writes)"
      : "🚀 LIVE PRICE SYNC — WRITING TO MEDUSA"
  );
  logger.info("Polling QB Bridge... may take 2-5 minutes.");
  logger.info("=".repeat(60));

  try {
    await client.connect();
    const result = await syncPricesCore(container, { dryRun: isDryRun });

    logger.info("\n" + "=".repeat(60));
    if (result.success) {
      logger.info(isDryRun ? "✅ DRY RUN COMPLETE" : "✅ LIVE SYNC COMPLETE");
      logger.info(`   Updated retail:      ${result.stats.updatedPrice ?? 0}`);
      logger.info(
        `   Updated wholesale:   ${result.stats.updatedWholesale ?? 0}`
      );
      logger.info(
        `   Skipped (no change): ${result.stats.skippedNoChange ?? 0}`
      );
      logger.info(`   Missing in QB:       ${result.stats.missingInQb ?? 0}`);

      if (!isDryRun) {
        await client.query(
          `UPDATE quickbooks_config SET last_price_sync = NOW(), updated_at = NOW() WHERE id = 'default'`
        );
        logger.info("   ✅ last_price_sync updated in DB");
      }
    } else {
      logger.error(`❌ Sync failed: ${result.error}`);
    }
    logger.info("=".repeat(60));
  } finally {
    await client.end();
  }
}
