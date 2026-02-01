import { ExecArgs } from "@medusajs/framework/types"
import { syncPricesCore } from "../lib/quickbooks/sync-prices-core"

/**
 * Sync ONLY PRICES from QuickBooks
 * Run: yarn medusa exec ./src/scripts/sync-qb-prices.ts
 * Schedule: 1x per day (night)
 */
export default async function syncQbPrices({ container }: ExecArgs) {
    await syncPricesCore(container)
}
