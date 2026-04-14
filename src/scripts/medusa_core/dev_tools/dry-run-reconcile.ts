import { ExecArgs } from "@medusajs/framework/types";
import { reconcileCustomersCore } from "../../lib/quickbooks/reconcile-customers-core";

/**
 * DRY RUN — Customer Reconciliation
 *
 * Shows what customers already in Medusa would get linked to QB records.
 * Bypasses API rates, runs locally directly. No DB changes.
 *
 * Run with: npx medusa exec ./src/scripts/diagnostics/dry-run-reconcile.ts
 */
export default async function dryRunReconcile({ container }: ExecArgs) {
  const logger = container.resolve("logger");

  logger.info("=========================================");
  logger.info("🚀 STARTING DRY RUN RECONCILIATION");
  logger.info("=========================================");

  const result = await reconcileCustomersCore(container, {
    dryRun: true,
  });

  if (result.success) {
    logger.info(`✅ Script completed successfully!`);
  } else {
    logger.error(`❌ Script failed: ${result.error}`);
  }
}
