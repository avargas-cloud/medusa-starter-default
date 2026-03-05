import { MedusaContainer } from "@medusajs/framework/types"
import { Client } from "pg"
import { syncInventoryCore } from "../lib/quickbooks/sync-inventory-core"
import { isQbIntegrationEnabled } from "../lib/quickbooks/qb-integration-guard"
import { QbSyncLogger } from "../lib/quickbooks/qb-sync-logger"

/**
 * QuickBooks Inventory Auto-Sync — cron fires every 10 minutes.
 *
 * The actual sync only executes when the configured interval has elapsed
 * since the last successful sync (inventory_interval_minutes in the DB).
 * This allows the user to configure 30/60/etc min without needing
 * Medusa to support dynamic cron schedules.
 *
 * Also respects store hours if inventory_respect_hours is enabled.
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

        // Read config — uses store_hours_* columns (unified with config UI)
        const { rows } = await client.query(`
            SELECT
                inventory_interval_minutes,
                last_inventory_sync,
                inventory_respect_hours,
                store_hours_open_hour,
                store_hours_close_hour,
                store_hours_timezone
            FROM quickbooks_config
            WHERE id = 'default'
        `)

        if (!rows.length) {
            console.warn(`${TAG} No config found — skipping.`)
            return
        }

        const {
            inventory_interval_minutes,
            last_inventory_sync,
            inventory_respect_hours,
            store_hours_open_hour,
            store_hours_close_hour,
            store_hours_timezone,
        } = rows[0]

        // Respect the "Disabled" setting in the UI
        if (!inventory_interval_minutes) {
            console.log(`${TAG} Inventory auto-sync is disabled (interval = null). Skipping.`)
            return
        }

        // ─── Interval check ──────────────────────────────────────────────────
        // The cron fires every 10 min; the actual sync only runs when the
        // configured interval (e.g. 30 min) has elapsed since last sync.
        if (last_inventory_sync) {
            const elapsedMs = Date.now() - new Date(last_inventory_sync).getTime()
            const intervalMs = inventory_interval_minutes * 60 * 1000
            if (elapsedMs < intervalMs) {
                const remainingMin = Math.round((intervalMs - elapsedMs) / 60000)
                console.log(
                    `${TAG} ⏳ Not due yet — next sync in ~${remainingMin} min (interval: ${inventory_interval_minutes}m). Skipping.`
                )
                return
            }
        }
        // ─────────────────────────────────────────────────────────────────────

        // ─── Store hours check ────────────────────────────────────────────────
        if (inventory_respect_hours && store_hours_open_hour != null && store_hours_close_hour != null) {
            const tz = store_hours_timezone || "America/New_York"
            const now = new Date()

            const currentHour = parseInt(
                new Intl.DateTimeFormat("en-US", {
                    hour: "numeric",
                    hour12: false,
                    timeZone: tz,
                }).format(now),
                10
            )

            const start = Number(store_hours_open_hour)
            const end = Number(store_hours_close_hour)

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
    schedule: "*/10 * * * *",   // fires every 10 min; interval check done internally
}
