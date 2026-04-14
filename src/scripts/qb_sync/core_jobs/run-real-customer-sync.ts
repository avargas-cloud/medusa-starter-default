import { ExecArgs } from "@medusajs/framework/types";
import { syncCustomersCore } from "../../../lib/quickbooks/sync-customers-core";

/**
 * Runs the real customer sync directly from the command line.
 * Bypasses the API rate limits and auth, running the core logic directly.
 *
 * Run with: npx medusa exec ./src/scripts/diagnostics/run-real-customer-sync.ts
 */
export default async function runRealCustomerSync({ container }: ExecArgs) {
  const logger = container.resolve("logger");

  logger.info("=========================================");
  logger.info("🚀 STARTING REAL CUSTOMER SYNC");
  logger.info("=========================================");

  const result = await syncCustomersCore(container, {});

  if (result.success) {
    logger.info(`✅ Sync completed successfully!`);
    logger.info(`Imported: ${result.stats?.imported}`);
    logger.info(`Already in Medusa: ${result.stats?.alreadyInMedusa}`);
    logger.info(`Errors: ${result.stats?.errors}`);
  } else {
    logger.error(`❌ Sync failed: ${result.error}`);
  }
}
