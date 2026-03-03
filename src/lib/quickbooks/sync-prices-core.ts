import { ContainerRegistrationKeys, Modules } from "@medusajs/utils"
import { IPricingModuleService } from "@medusajs/types"
import { isQbIntegrationEnabled } from "./qb-integration-guard"
import { syncInventoryWorkflow } from "../../workflows/sync-inventory"

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
    options: { dryRun?: boolean; onLog?: (line: string) => void } = {}
): Promise<SyncPricesResult> {
    const dryRun = options.dryRun || process.env.QB_DRY_RUN === "true"

    // Master integration kill switch — check DB + env var
    if (!(await isQbIntegrationEnabled())) {
        options.onLog?.("[QB] Integration is DISABLED. Skipping price sync.")
        return {
            success: false,
            dryRun,
            stats: { totalLinkedVariants: 0, foundInQb: 0, missingInQb: 0, updatedPrice: 0, updatedWholesale: 0, skippedNoChange: 0, skippedNoPrice: 0, skippedAnomaly: 0 },
            error: "QB integration is disabled"
        }
    }
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const log = (line: string) => { logger.info(line); options.onLog?.(line) }
    const warn = (line: string) => { logger.warn(line); options.onLog?.(`⚠️ ${line}`) }
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
        log(`💰 Starting QuickBooks PRICE Sync (ONLY)...${dryRun ? " [DRY RUN — no changes will be written]" : ""}`)
        log(`⏰ Sync initiated: ${new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZoneName: 'short' })}`)

        // Fetch Wholesale Price List + Customer Group ID once (used for every price update)
        let wholesalePriceListId: string | null = null
        let wholesaleGroupId: string | null = null
        try {
            const allPriceLists = await pricingModule.listPriceLists()
            const wPriceList = allPriceLists.find((pl: any) => pl.title === "Wholesale Pricing")
            wholesalePriceListId = wPriceList?.id ?? null
            if (wholesalePriceListId) {
                log(`🏷️  Wholesale Price List found: ${wholesalePriceListId}`)
                // Fetch Wholesale customer group
                const customerModule = container.resolve(Modules.CUSTOMER)
                const wholesaleGroups = await customerModule.listCustomerGroups({ name: ["Wholesale"] })
                wholesaleGroupId = wholesaleGroups[0]?.id ?? null
                if (wholesaleGroupId) {
                    log(`👥 Wholesale Customer Group ID: ${wholesaleGroupId}`)
                } else {
                    warn(`⚠️  Wholesale customer group not found — prices will still be stored in price list but without customer group rule`)
                }
            } else {
                warn(`⚠️  Wholesale Price List "Wholesale Pricing" not found — wholesale prices will NOT be updated`)
            }
        } catch (e: any) {
            warn(`⚠️  Could not fetch wholesale price list: ${e.message}`)
        }

        // 1. Fetch Medusa Products with QB ID
        log("🔍 Fetching Medusa Products with QuickBooks ID...")
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
        log(`📊 Found ${qbVariants.length} variants linked to QuickBooks.`)

        if (qbVariants.length === 0) {
            log("⚠️ No linked products found. Run 'assign-quickbooks-ids' first.")
            return { success: false, stats, error: "No linked products found" }
        }

        // 2. Initiate Bulk Sync
        log("📡 Requesting Bulk Data from Bridge...")
        const initRes = await fetch(`${BRIDGE_URL}/api/products`, {
            headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" }
        })

        if (!initRes.ok) {
            const error = `Bridge Error: ${initRes.status} ${initRes.statusText}`
            logger.error(`❌ ${error}`)
            return { success: false, stats, error }
        }

        const initJson: any = await initRes.json()
        const operationId = initJson.operationId
        log(`✅ Operation Queued! ID: ${operationId}`)

        // 3. Polling Loop
        let qbData: any[] = []
        let attempts = 0

        while (attempts < MAX_POLL_ATTEMPTS) {
            attempts++
            log(`⏳ Polling Status (${attempts}/${MAX_POLL_ATTEMPTS})...`)

            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))

            const statusRes = await fetch(`${BRIDGE_URL}/api/sync/status/${operationId}`, {
                headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" }
            })

            if (!statusRes.ok) {
                warn(`   Bridge Status Error: ${statusRes.status}`)
                continue
            }

            const statusJson: any = await statusRes.json()

            if (statusJson.success && statusJson.operation) {
                if (statusJson.operation.status === "completed") {
                    // Bridge returns parsed XML in operation.result
                    // Structure: result.QBXML.QBXMLMsgsRs.ItemQueryRs.ItemInventoryRet[]
                    const queryRs = statusJson.operation?.result?.QBXML?.QBXMLMsgsRs?.ItemQueryRs
                    if (queryRs) {
                        const inventoryItems = queryRs.ItemInventoryRet || []
                        qbData = Array.isArray(inventoryItems) ? inventoryItems : [inventoryItems]
                    }
                    log(`✅ Data Received! ${qbData.length} items from QuickBooks.`)
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
        log("\n💵 Processing Price Updates...")

        const qbMap = new Map(qbData.map((item: any) => [item.ListID, item]))



        for (const variant of qbVariants) {
            const qbId = (variant.metadata as any)?.quickbooks_id
            const qbItem = qbMap.get(qbId)

            if (!qbItem) {
                stats.missingInQb++
                warn(`   ⚠️ ${variant.sku} not found in QB Response.`)
                continue
            }

            const newPrice = parseFloat(qbItem.SalesPrice)

            if (!variant.price_set) {
                stats.skippedNoPrice++
                warn(`   ❌ ${variant.sku}: No Price Set linked.`)
                continue
            }

            if (isNaN(newPrice)) {
                stats.skippedNoPrice++
                warn(`   ⚠️ ${variant.sku}: Invalid price in QB`)
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

                // NOTE: Anomaly guard removed — QB prices are authoritative.
                // High Medusa prices (e.g. $607 vs QB $7.49) are the historical
                // cents-as-dollars bug. We trust QB and overwrite.

                // Compare dollars to dollars — skip if unchanged (within $0.01 tolerance)
                if (Math.abs(currentAmount - newPrice) < 0.01) {
                    stats.skippedNoChange++
                    continue
                }

                if (dryRun) {
                    const wsPreview = wholesalePriceListId ? ` (wholesale would be: $${smartRound(newPrice * 0.9).toFixed(2)})` : ""
                    log(`   [DRY RUN] Would update ${variant.sku || variant.id}: $${currentAmount.toFixed(2)} → $${newPrice.toFixed(2)}${wsPreview}`)
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
                log(`   💵 Retail updated ${variant.sku || variant.id}: $${currentAmount.toFixed(2)} → $${newPrice.toFixed(2)}`)

                // Update wholesale for THIS variant only — per-variant, no delete-all
                if (wholesalePriceListId && variant.price_set) {
                    const wholesalePrice = smartRound(newPrice * 0.9)
                    try {
                        // Find and delete only THIS variant's existing wholesale price
                        const existingWholesale = await pricingModule.listPrices({
                            price_set_id: [variant.price_set.id],
                            price_list_id: [wholesalePriceListId]
                        })
                        if (existingWholesale.length > 0) {
                            await (pricingModule as any).deletePrices(existingWholesale.map((p: any) => p.id))
                        }
                        // Create new wholesale price for this variant
                        await (pricingModule as any).createPrices([{
                            price_set_id: variant.price_set.id,
                            price_list_id: wholesalePriceListId,
                            currency_code: "usd",
                            amount: wholesalePrice,
                            rules: wholesaleGroupId ? { customer_group_id: wholesaleGroupId } : {}
                        }])
                        stats.updatedWholesale++
                        log(`   🏷️  Wholesale updated ${variant.sku || variant.id}: $${wholesalePrice.toFixed(2)} (10% off)`)
                    } catch (wsErr: any) {
                        warn(`   ⚠️  Wholesale update failed for ${variant.sku}: ${wsErr.message}`)
                    }
                }

                if (stats.updatedPrice % 25 === 0) {
                    log(`   ✅ Progress: ${stats.updatedPrice} prices updated...`)
                }
            } catch (err: any) {
                logger.error(`   ❌ ${variant.sku}: Price Update Failed - ${err.message}`)
            }
        }

        log(`\n${"=".repeat(50)}`)
        log(`✅ PRICE SYNC SUMMARY${dryRun ? " [DRY RUN]" : ""}`)
        log(`${"=".repeat(50)}`)
        log(`Total Linked Variants: ${stats.totalLinkedVariants}`)
        log(`Found in QB:           ${stats.foundInQb}`)
        log(`Missing in QB:         ${stats.missingInQb}`)
        log(`Updated (Retail):      ${stats.updatedPrice}${dryRun ? " (would update)" : ""}`)
        log(`Updated (Wholesale):   ${stats.updatedWholesale}${dryRun ? " (would update)" : ""} — auto-calculated at 10% off`)
        log(`Skipped (Unchanged):   ${stats.skippedNoChange}`)
        log(`Skipped (No Price):    ${stats.skippedNoPrice}`)
        log(`Skipped (Anomaly 10x): ${stats.skippedAnomaly}`)
        log(`${"=".repeat(50)}\n`)

        // ─── Auto-update Meilisearch Inventory Index ──────────────────────────────
        // If prices were actually written to DB, re-index inventory so the
        // inventory-advanced UI reflects the new prices immediately.
        // Skip on dry run (no DB changes were made).
        if (!dryRun && stats.updatedPrice > 0) {
            log(`\n🔍 Re-indexing Meilisearch inventory with updated prices...`)
            try {
                const meiliResult = await syncInventoryWorkflow(container).run({ input: {} })
                log(`✅ Meilisearch re-indexed ${meiliResult.result.synced} inventory items`)
            } catch (meiliErr: any) {
                // Don't fail the whole sync if Meilisearch fails
                warn(`⚠️ Meilisearch re-index failed (non-blocking): ${meiliErr.message}`)
            }
        }

        return { success: true, dryRun, stats }

    } catch (error: any) {
        logger.error(`❌ Sync failed: ${error.message}`)
        return { success: false, stats, error: error.message }
    }
}
