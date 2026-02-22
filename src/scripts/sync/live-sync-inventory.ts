import { ExecArgs } from "@medusajs/framework/types"
import { syncInventoryCore } from "../../lib/quickbooks/sync-inventory-core"
import { Client } from "pg"

/**
 * Live inventory sync — calls syncInventoryCore (same function as the API button).
 * Applies the negative stock clamp (QB negatives → 0).
 * Updates last_inventory_sync in DB on success.
 *
 * Usage:
 *   npx medusa exec src/scripts/sync/live-sync-inventory.ts
 */
export default async function liveSyncInventory({ container }: ExecArgs) {
    const { ContainerRegistrationKeys } = await import("@medusajs/framework/utils")
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const client = new Client({ connectionString: process.env.DATABASE_URL })

    logger.info("=".repeat(60))
    logger.info("🚀 LIVE INVENTORY SYNC — WRITING TO MEDUSA")
    logger.info("Polling QB Bridge... may take 2-5 minutes.")
    logger.info("=".repeat(60))

    try {
        await client.connect()
        const result = await syncInventoryCore(container, { dryRun: false })

        logger.info("\n" + "=".repeat(60))
        if (result.success) {
            logger.info("✅ LIVE SYNC COMPLETE")
            logger.info(`   Updated:             ${result.stats.updatedStock}`)
            logger.info(`   Skipped (no change): ${result.stats.skippedNoChange ?? 0}`)
            logger.info(`   Missing in QB:       ${result.stats.missingInQb}`)
            logger.info(`   No inventory item:   ${result.stats.skippedNoInventoryItem}`)
            if (result.anomalies && result.anomalies.length > 0) {
                logger.info(`   Anomalies applied:   ${result.anomalies.length}`)
            }

            // Persist the sync timestamp
            await client.query(
                `UPDATE quickbooks_config SET last_inventory_sync = NOW(), updated_at = NOW() WHERE id = 'default'`
            )
            logger.info("   ✅ last_inventory_sync updated in DB")
        } else {
            logger.error(`❌ Sync failed: ${result.error}`)
        }
        logger.info("=".repeat(60))
    } finally {
        await client.end()
    }
}
