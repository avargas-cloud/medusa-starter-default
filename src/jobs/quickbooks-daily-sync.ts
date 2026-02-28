import { MedusaContainer } from "@medusajs/framework/types"
import { Client } from "pg"
import { syncPricesCore } from "../lib/quickbooks/sync-prices-core"
import { syncCustomersCore } from "../lib/quickbooks/sync-customers-core"
import { isQbIntegrationEnabled } from "../lib/quickbooks/qb-integration-guard"
import { QbSyncLogger } from "../lib/quickbooks/qb-sync-logger"

/**
 * QuickBooks Daily Sync — runs at midnight (00:00 server time).
 *
 * Handles: Price sync (daily at 00:00) + Customer sync (if configured).
 * Inventory sync has its own dedicated job: quickbooks-inventory-sync.ts (every 10 min).
 *
 * NOTE: syncPricesCore() polls the QB Bridge (up to ~10 minutes).
 * Same behavior as the manual "Sync Now" button.
 */
export default async function qbDailySyncHandler(container: MedusaContainer) {
    const TAG = "[QB-AUTO-SYNC]"
    const client = new Client({ connectionString: process.env.DATABASE_URL })

    try {
        await client.connect()

        // Master kill switch
        if (!(await isQbIntegrationEnabled())) {
            console.log(`${TAG} Integration disabled — skipping all syncs.`)
            return
        }

        const { rows } = await client.query(`
            SELECT
                price_interval_minutes,
                customer_interval_minutes,
                last_price_sync,
                last_customer_sync
            FROM quickbooks_config
            WHERE id = 'default'
        `)

        if (!rows.length) {
            console.warn(`${TAG} No config row found — skipping.`)
            return
        }

        const cfg = rows[0]

        /**
         * The cron schedule controls WHEN to run — we only check if the module is enabled.
         * We intentionally ignore last_sync so that a manual "Sync Now" earlier in the day
         * does NOT prevent the scheduled cron from running at its configured time.
         */
        const hasInterval = (intervalMinutes: number | null): boolean => !!intervalMinutes

        // ─── Price Sync ────────────────────────────────────────────────────
        if (hasInterval(cfg.price_interval_minutes)) {
            console.log(`${TAG} ⏰ Running price sync (this may take several minutes while QB processes the request)...`)
            const logId = await QbSyncLogger.start({
                operation: "price_sync",
                syncType: "price",
                triggeredBy: "auto",
                message: "Scheduled price sync started",
                db: client,
            })
            try {
                const result = await syncPricesCore(container as any)
                if (result.success) {
                    await client.query(
                        `UPDATE quickbooks_config SET last_price_sync = NOW(), updated_at = NOW() WHERE id = 'default'`
                    )
                    const msg = `Prices: ${result.stats.updatedPrice} retail + ${result.stats.updatedWholesale ?? 0} wholesale updated`
                    console.log(`${TAG} ✅ ${msg}`)
                    await QbSyncLogger.complete(logId, { message: msg, db: client })
                } else {
                    console.error(`${TAG} ❌ Price sync failed: ${result.error}`)
                    await QbSyncLogger.fail(logId, result.error || "Unknown error", { db: client })
                }
            } catch (e: any) {
                console.error(`${TAG} ❌ Price sync threw: ${e.message}`)
                await QbSyncLogger.fail(logId, e.message, { db: client })
            }
        }

        // ─── Customer Sync ─────────────────────────────────────────────────
        if (hasInterval(cfg.customer_interval_minutes)) {
            console.log(`${TAG} ⏰ Running customer sync...`)
            const logId = await QbSyncLogger.start({
                operation: "customer_sync",
                syncType: "customer",
                triggeredBy: "auto",
                message: "Scheduled customer sync started",
                db: client,
            })
            try {
                const result = await syncCustomersCore(container as any)
                if (result.success) {
                    await client.query(
                        `UPDATE quickbooks_config SET last_customer_sync = NOW(), updated_at = NOW() WHERE id = 'default'`
                    )
                    const msg = `Customers: ${result.stats?.imported ?? 0} imported`
                    console.log(`${TAG} ✅ ${msg}`)
                    await QbSyncLogger.complete(logId, { message: msg, db: client })
                } else {
                    console.error(`${TAG} ❌ Customer sync failed: ${result.error}`)
                    await QbSyncLogger.fail(logId, result.error || "Unknown error", { db: client })
                }
            } catch (e: any) {
                console.error(`${TAG} ❌ Customer sync threw: ${e.message}`)
                await QbSyncLogger.fail(logId, e.message, { db: client })
            }
        }

        // ─── Log Cleanup (fallback if pg_cron not available) ───────────────
        try {
            const deleted = await QbSyncLogger.cleanup(90, client)
            if (deleted > 0) console.log(`${TAG} 🗑️ Cleaned up ${deleted} old QB sync log entries (>90 days)`)
        } catch { /* non-blocking */ }

    } catch (error: any) {
        console.error(`${TAG} Job outer failure: ${error.message}`)
    } finally {
        await client.end()
    }
}

/**
 * Medusa scheduled job config.
 * "0 0 * * *" = daily at midnight — for price sync (24h) and customer sync.
 * Inventory sync is handled by quickbooks-inventory-sync.ts (every 10 min).
 */
export const config = {
    name: "quickbooks-daily-sync",
    schedule: "0 0 * * *",
}
