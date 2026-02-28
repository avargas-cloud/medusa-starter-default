import { MedusaContainer } from "@medusajs/framework/types"
import { Client } from "pg"
import { syncInventoryCore } from "../lib/quickbooks/sync-inventory-core"
import { isQbIntegrationEnabled } from "../lib/quickbooks/qb-integration-guard"
import { QbSyncLogger } from "../lib/quickbooks/qb-sync-logger"

/**
 * QuickBooks Inventory Auto-Sync — runs every 10 minutes.
 *
 * Respects a store-hours time window configured in the admin panel:
 *   inventory_sync_start_hour (e.g. 9)  → don't sync before 9:00 AM
 *   inventory_sync_end_hour   (e.g. 18) → don't sync after  6:00 PM
 *   inventory_sync_timezone              → timezone for the window check
 *
 * When both are NULL, syncs run 24/7 (original behavior).
 *
 * Schedule: every 10 minutes (skipped outside store hours)
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
            SELECT
                inventory_interval_minutes,
                last_inventory_sync,
                inventory_sync_start_hour,
                inventory_sync_end_hour,
                inventory_sync_timezone
            FROM quickbooks_config
            WHERE id = 'default'
        `)

        if (!rows.length) {
            console.warn(`${TAG} No config found — skipping.`)
            return
        }

        const {
            inventory_interval_minutes,
            inventory_sync_start_hour,
            inventory_sync_end_hour,
            inventory_sync_timezone,
        } = rows[0]

        // Respect the "Disabled" setting in the UI
        if (!inventory_interval_minutes) {
            console.log(`${TAG} Inventory auto-sync is disabled (interval = null). Skipping.`)
            return
        }

        // ─── Store hours check ────────────────────────────────────────────────
        // If start & end hours are configured, only run within that window.
        if (inventory_sync_start_hour != null && inventory_sync_end_hour != null) {
            const tz = inventory_sync_timezone || "America/New_York"
            const now = new Date()

            // Get current hour in store timezone
            const currentHour = parseInt(
                new Intl.DateTimeFormat("en-US", {
                    hour: "numeric",
                    hour12: false,
                    timeZone: tz,
                }).format(now),
                10
            )

            const start = Number(inventory_sync_start_hour)
            const end = Number(inventory_sync_end_hour)

            if (currentHour < start || currentHour >= end) {
                console.log(
                    `${TAG} Outside store hours (${currentHour}:xx — window is ${start}:00–${end}:00 ${tz}). Skipping sync.`
                )
                return
            }
        }
        // ─────────────────────────────────────────────────────────────────────

        const logId = await QbSyncLogger.start({
            operation: "inventory_sync",
            syncType: "inventory",
            triggeredBy: "auto",
            message: `Inventory sync started (interval: ${inventory_interval_minutes}m)`,
            db: client,
        })

        console.log(`${TAG} ⏰ Running inventory sync (interval: ${inventory_interval_minutes}m)...`)
        const result = await syncInventoryCore(container as any)

        if (result.success) {
            await client.query(
                `UPDATE quickbooks_config SET last_inventory_sync = NOW(), updated_at = NOW() WHERE id = 'default'`
            )
            const msg = `Done: ${result.stats.updatedStock} levels updated`
            console.log(`${TAG} ✅ ${msg}`)
            await QbSyncLogger.complete(logId, { message: msg, db: client })
        } else {
            console.error(`${TAG} ❌ Sync failed: ${result.error}`)
            await QbSyncLogger.fail(logId, result.error || "Unknown error", { db: client })
        }

    } catch (error: any) {
        console.error(`${TAG} Job error: ${error.message}`)
    } finally {
        await client.end()
    }
}

export const config = {
    name: "quickbooks-inventory-sync",
    schedule: "*/10 * * * *",   // every 10 minutes — skipped outside store hours
}
