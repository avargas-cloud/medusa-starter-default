import { MedusaContainer } from "@medusajs/framework/types"
import { Client } from "pg"
import { syncPricesCore } from "../lib/quickbooks/sync-prices-core"
import { syncCustomersCore } from "../lib/quickbooks/sync-customers-core"
import { isQbIntegrationEnabled } from "../lib/quickbooks/qb-integration-guard"

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
            try {
                const result = await syncPricesCore(container as any)
                if (result.success) {
                    await client.query(
                        `UPDATE quickbooks_config SET last_price_sync = NOW(), updated_at = NOW() WHERE id = 'default'`
                    )
                    console.log(`${TAG} ✅ Prices: ${result.stats.updatedPrice} retail + ${result.stats.updatedWholesale ?? 0} wholesale updated`)
                } else {
                    console.error(`${TAG} ❌ Price sync failed: ${result.error}`)
                }
            } catch (e: any) {
                console.error(`${TAG} ❌ Price sync threw: ${e.message}`)
            }
        }

        // ─── Customer Sync ─────────────────────────────────────────────────
        if (hasInterval(cfg.customer_interval_minutes)) {
            console.log(`${TAG} ⏰ Running customer sync...`)
            try {
                const result = await syncCustomersCore(container as any)
                if (result.success) {
                    await client.query(
                        `UPDATE quickbooks_config SET last_customer_sync = NOW(), updated_at = NOW() WHERE id = 'default'`
                    )
                    console.log(`${TAG} ✅ Customers: ${result.stats?.imported ?? 0} imported`)
                } else {
                    console.error(`${TAG} ❌ Customer sync failed: ${result.error}`)
                }
            } catch (e: any) {
                console.error(`${TAG} ❌ Customer sync threw: ${e.message}`)
            }
        }

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
