import { MedusaContainer } from "@medusajs/framework/types"
import { Client } from "pg"
import { syncInventoryCore } from "../lib/quickbooks/sync-inventory-core"
import { isQbIntegrationEnabled } from "../lib/quickbooks/qb-integration-guard"

/**
 * QuickBooks Inventory Auto-Sync — runs every 10 minutes.
 *
 * Same syncInventoryCore() that the manual "Sync Now" button uses:
 *   - Polling QB Bridge → XML parse → update Medusa inventory levels
 *   - Negative stock clamped to 0
 *   - Auto re-indexes Meilisearch on success
 *   - Updates last_inventory_sync in quickbooks_config
 *
 * The job respects the configured interval: if inventory_interval_minutes
 * is null/disabled, the job skips gracefully.
 *
 * Schedule: "* /10 * * * *" (every 10 minutes)
 * NOTE: inventory sync polls QB Bridge and can take 2-5 min to complete.
 */
export default async function qbInventorySyncHandler(container: MedusaContainer) {
    const TAG = "[QB-INVENTORY-AUTO]"
    const client = new Client({ connectionString: process.env.DATABASE_URL })

    try {
        await client.connect()

        // Master kill switch
        if (!(await isQbIntegrationEnabled())) {
            console.log(`${TAG} Integration disabled — skipping.`)
            return
        }

        // Read config
        const { rows } = await client.query(`
            SELECT inventory_interval_minutes, last_inventory_sync
            FROM quickbooks_config
            WHERE id = 'default'
        `)

        if (!rows.length) {
            console.warn(`${TAG} No config found — skipping.`)
            return
        }

        const { inventory_interval_minutes } = rows[0]

        // Respect the "Disabled" setting in the UI
        if (!inventory_interval_minutes) {
            console.log(`${TAG} Inventory auto-sync is disabled (interval = null). Skipping.`)
            return
        }

        // Run the sync — cron schedule controls frequency, not elapsed time
        console.log(`${TAG} ⏰ Running inventory sync (interval: ${inventory_interval_minutes}m)...`)
        const result = await syncInventoryCore(container as any)

        if (result.success) {
            // Update timestamp in DB (syncInventoryCore already handles Meilisearch re-index)
            await client.query(
                `UPDATE quickbooks_config SET last_inventory_sync = NOW(), updated_at = NOW() WHERE id = 'default'`
            )
            console.log(`${TAG} ✅ Done: ${result.stats.updatedStock} levels updated`)
        } else {
            console.error(`${TAG} ❌ Sync failed: ${result.error}`)
        }

    } catch (error: any) {
        console.error(`${TAG} Job error: ${error.message}`)
    } finally {
        await client.end()
    }
}

export const config = {
    name: "quickbooks-inventory-sync",
    schedule: "*/10 * * * *",   // every 10 minutes
}
