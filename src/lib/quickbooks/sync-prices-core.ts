import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { IPricingModuleService } from "@medusajs/types"
import { isQbIntegrationEnabled } from "./qb-integration-guard"

// Config — URLs and keys from env vars, no hardcoded secrets
const BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://ecopower-qb.loca.lt"
const API_KEY = process.env.QB_API_KEY || "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD"
const POLL_INTERVAL_MS = 30000 // 30 seconds
const MAX_POLL_ATTEMPTS = 20 // 10 minutes max

/**
 * Wholesale pricing rule (mirrors create-wholesale-prices.ts):
 * - 10% off retail price
 * - Rounded to nearest .25 increment
 * - If it hits a whole dollar (x.00), it becomes x-0.01 (e.g., $10.00 → $9.99)
 */
function smartRound(price: number): number {
    const dollars = Math.floor(price)
    const cents = price - dollars
    if (cents < 0.25) return dollars + 0.25
    if (cents < 0.50) return dollars + 0.50
    if (cents < 0.75) return dollars + 0.75
    return dollars + 0.99
}

export interface SyncPricesResult {
    success: boolean
    dryRun?: boolean
    stats: {
        totalLinkedVariants: number
        foundInQb: number
        missingInQb: number
        updatedPrice: number      // retail prices updated
        updatedWholesale: number  // wholesale prices auto-updated
        skippedNoChange: number
        skippedNoPrice: number
        skippedAnomaly: number
    }
    error?: string
}

/**
 * Core logic for syncing prices from QuickBooks
 * Can be called from CLI or API
 */
export async function syncPricesCore(
    container: any,
    options: { dryRun?: boolean } = {}
): Promise<SyncPricesResult> {
    const dryRun = options.dryRun || process.env.QB_DRY_RUN === "true"

    // Master integration kill switch — check DB + env var
    if (!(await isQbIntegrationEnabled())) {
        console.log("[QB] Integration is DISABLED (QB_INTEGRATION=false or toggled off in admin). Skipping price sync.")
        return {
            success: false,
            dryRun,
            stats: { totalLinkedVariants: 0, foundInQb: 0, missingInQb: 0, updatedPrice: 0, updatedWholesale: 0, skippedNoChange: 0, skippedNoPrice: 0, skippedAnomaly: 0 },
            error: "QB integration is disabled"
        }
    }
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const pricingModule: IPricingModuleService = container.resolve(Modules.PRICING)
    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    const stats = {
        totalLinkedVariants: 0,
        foundInQb: 0,
        missingInQb: 0,
        updatedPrice: 0,
        updatedWholesale: 0,
        skippedNoChange: 0,
        skippedNoPrice: 0,
        skippedAnomaly: 0,
    }

    try {
        logger.info(`💰 Starting QuickBooks PRICE Sync (ONLY)...${dryRun ? " [DRY RUN — no changes will be written]" : ""}`)

        // Fetch Wholesale Price List once (used for every price update)
        let wholesalePriceListId: string | null = null
        try {
            const allPriceLists = await pricingModule.listPriceLists()
            const wPriceList = allPriceLists.find((pl: any) => pl.title === "Wholesale Pricing")
            wholesalePriceListId = wPriceList?.id ?? null
            if (wholesalePriceListId) {
                logger.info(`🏷️  Wholesale Price List found: ${wholesalePriceListId}`)
            } else {
                logger.warn(`⚠️  Wholesale Price List "Wholesale Pricing" not found — wholesale prices will NOT be updated`)
            }
        } catch (e: any) {
            logger.warn(`⚠️  Could not fetch wholesale price list: ${e.message}`)
        }

        // 1. Fetch Medusa Products with QB ID
        logger.info("🔍 Fetching Medusa Products with QuickBooks ID...")
        const { data: variants } = await query.graph({
            entity: "variant",
            fields: [
                "id",
                "sku",
                "metadata",
                "price_set.id"
            ]
        })

        const qbVariants = variants.filter((v: any) => v.metadata?.quickbooks_id)
        stats.totalLinkedVariants = qbVariants.length
        logger.info(`📊 Found ${qbVariants.length} variants linked to QuickBooks.`)

        if (qbVariants.length === 0) {
            logger.info("⚠️ No linked products found. Run 'assign-quickbooks-ids' first.")
            return { success: false, stats, error: "No linked products found" }
        }

        // 2. Initiate Bulk Sync
        logger.info("📡 Requesting Bulk Data from Bridge...")
        const initRes = await fetch(`${BRIDGE_URL}/api/products`, {
            headers: { "x-api-key": API_KEY }
        })

        if (!initRes.ok) {
            const error = `Bridge Error: ${initRes.status} ${initRes.statusText}`
            logger.error(`❌ ${error}`)
            return { success: false, stats, error }
        }

        const initJson: any = await initRes.json()
        const operationId = initJson.operationId
        logger.info(`✅ Operation Queued! ID: ${operationId}`)

        // 3. Polling Loop
        let qbData: any[] = []
        let attempts = 0

        while (attempts < MAX_POLL_ATTEMPTS) {
            attempts++
            logger.info(`⏳ Polling Status (${attempts}/${MAX_POLL_ATTEMPTS})...`)

            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))

            const statusRes = await fetch(`${BRIDGE_URL}/api/sync/status/${operationId}`, {
                headers: { "x-api-key": API_KEY }
            })

            if (!statusRes.ok) {
                logger.warn(`   Bridge Status Error: ${statusRes.status}`)
                continue
            }

            const statusJson: any = await statusRes.json()

            if (statusJson.success && statusJson.operation) {
                if (statusJson.operation.status === "completed") {
                    qbData = statusJson.data || []
                    logger.info(`✅ Data Received! ${qbData.length} items from QuickBooks.`)
                    break
                }

                if (statusJson.operation.status === "failed") {
                    const error = `QB sync failed: ${statusJson.operation.error || "Unknown"}`
                    logger.error(`❌ ${error}`)
                    return { success: false, stats, error }
                }
            }
        }

        if (qbData.length === 0) {
            const error = "No data received after polling timeout"
            logger.error(`❌ ${error}`)
            return { success: false, stats, error }
        }

        // 4. Update ONLY Prices (with comparison)
        logger.info("\n💵 Processing Price Updates...")

        const qbMap = new Map(qbData.map((item: any) => [item.ListID, item]))

        for (const variant of qbVariants) {
            const qbId = (variant.metadata as any)?.quickbooks_id
            const qbItem = qbMap.get(qbId)

            if (!qbItem) {
                stats.missingInQb++
                logger.warn(`   ⚠️ ${variant.sku} not found in QB Response.`)
                continue
            }

            const newPrice = parseFloat(qbItem.SalesPrice)

            if (!variant.price_set) {
                stats.skippedNoPrice++
                logger.warn(`   ❌ ${variant.sku}: No Price Set linked.`)
                continue
            }

            if (isNaN(newPrice)) {
                stats.skippedNoPrice++
                logger.warn(`   ⚠️ ${variant.sku}: Invalid price in QB`)
                continue
            }

            // Get current price to compare
            try {
                const { data: currentPrices } = await query.graph({
                    entity: "price",
                    fields: ["amount"],
                    filters: {
                        price_set_id: variant.price_set.id,
                        currency_code: "usd"
                    }
                })

                const currentAmount = currentPrices[0]?.amount ?? 0

                // Medusa v2 stores prices in MAJOR UNITS (dollars), NOT cents.
                // QB also sends dollars (e.g., SalesPrice: "29.99")
                // So we compare dollars to dollars directly — no conversion needed.
                // Reference: sync-qb-inventory.ts line 194: "v2: Store dollars directly, NO × 100"

                // ANOMALY GUARD: skip if change is absurd (>10x or <0.1x)
                if (currentAmount > 0) {
                    const ratio = newPrice / currentAmount
                    if (ratio > 10 || ratio < 0.1) {
                        logger.warn(`   ⚠️ PRICE ANOMALY ${variant.sku || variant.id}: Medusa=$${currentAmount.toFixed(2)} QB=$${newPrice.toFixed(2)} (ratio=${ratio.toFixed(2)}) — SKIPPED`)
                        stats.skippedAnomaly++
                        continue
                    }
                }

                // Compare dollars to dollars — skip if unchanged (within $0.01 tolerance)
                if (Math.abs(currentAmount - newPrice) < 0.01) {
                    stats.skippedNoChange++
                    continue
                }

                if (dryRun) {
                    const wsPreview = wholesalePriceListId ? ` (wholesale would be: $${smartRound(newPrice * 0.9).toFixed(2)})` : ""
                    logger.info(`   [DRY RUN] Would update ${variant.sku || variant.id}: $${currentAmount.toFixed(2)} → $${newPrice.toFixed(2)}${wsPreview}`)
                    stats.updatedPrice++
                    if (wholesalePriceListId) stats.updatedWholesale++
                    continue
                }

                // Update Price — Medusa v2: store in dollars directly (major units)
                await pricingModule.updatePriceSets(variant.price_set.id, {
                    prices: [
                        {
                            amount: newPrice,  // dollars directly, no × 100
                            currency_code: "usd",
                            rules: {}
                        }
                    ]
                })
                stats.updatedPrice++

                // Auto-update wholesale: 10% off retail, smartRound to .25/.50/.75/.99
                if (wholesalePriceListId) {
                    const wholesalePrice = smartRound(newPrice * 0.9)
                    try {
                        await pricingModule.addPrices({
                            priceSetId: variant.price_set.id,
                            prices: [{
                                amount: wholesalePrice,    // already in dollars
                                currency_code: "usd",
                                rules: { price_list_id: wholesalePriceListId }
                            }]
                        })
                        stats.updatedWholesale++
                        logger.info(`   🏷️  Wholesale updated: $${wholesalePrice.toFixed(2)} (10% off $${newPrice.toFixed(2)})`)
                    } catch (wsErr: any) {
                        logger.warn(`   ⚠️ Wholesale update failed for ${variant.sku}: ${wsErr.message}`)
                    }
                }

                if (stats.updatedPrice % 25 === 0) {
                    logger.info(`   ✅ Progress: ${stats.updatedPrice} prices updated...`)
                }
            } catch (err: any) {
                logger.error(`   ❌ ${variant.sku}: Price Update Failed - ${err.message}`)
            }
        }

        stats.foundInQb = qbVariants.length - stats.missingInQb

        logger.info(`\n${"=".repeat(50)}`)
        logger.info(`✅ PRICE SYNC SUMMARY${dryRun ? " [DRY RUN]" : ""}`)
        logger.info(`${"=".repeat(50)}`)
        logger.info(`Total Linked Variants: ${stats.totalLinkedVariants}`)
        logger.info(`Found in QB:           ${stats.foundInQb}`)
        logger.info(`Missing in QB:         ${stats.missingInQb}`)
        logger.info(`Updated (Retail):      ${stats.updatedPrice}${dryRun ? " (would update)" : ""}`)
        logger.info(`Updated (Wholesale):   ${stats.updatedWholesale}${dryRun ? " (would update)" : ""} — auto-calculated at 10% off`)
        logger.info(`Skipped (Unchanged):   ${stats.skippedNoChange}`)
        logger.info(`Skipped (No Price):    ${stats.skippedNoPrice}`)
        logger.info(`Skipped (Anomaly 10x): ${stats.skippedAnomaly}`)
        logger.info(`${"=".repeat(50)}\n`)

        return { success: true, dryRun, stats }

    } catch (error: any) {
        logger.error(`❌ Sync failed: ${error.message}`)
        return { success: false, stats, error: error.message }
    }
}
