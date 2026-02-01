import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { IPricingModuleService } from "@medusajs/types"

// Config
const BRIDGE_URL = "https://ecopower-qb.loca.lt"
const API_KEY = "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD"
const POLL_INTERVAL_MS = 30000 // 30 seconds
const MAX_POLL_ATTEMPTS = 20 // 10 minutes max

export interface SyncPricesResult {
    success: boolean
    stats: {
        totalLinkedVariants: number
        foundInQb: number
        missingInQb: number
        updatedPrice: number
        skippedNoChange: number
        skippedNoPrice: number
    }
    error?: string
}

/**
 * Core logic for syncing prices from QuickBooks
 * Can be called from CLI or API
 */
export async function syncPricesCore(container: any): Promise<SyncPricesResult> {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const pricingModule: IPricingModuleService = container.resolve(Modules.PRICING)
    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    const stats = {
        totalLinkedVariants: 0,
        foundInQb: 0,
        missingInQb: 0,
        updatedPrice: 0,
        skippedNoChange: 0,
        skippedNoPrice: 0
    }

    try {
        logger.info(`💰 Starting QuickBooks PRICE Sync (ONLY)...`)

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

                const currentAmount = currentPrices[0]?.amount
                const newAmountInDollars = newPrice // QB sends dollars

                // Compare: Skip if unchanged
                if (currentAmount === newAmountInDollars) {
                    stats.skippedNoChange++
                    continue
                }

                // Update Price (v2: store in dollars directly)
                await pricingModule.updatePriceSets(variant.price_set.id, {
                    prices: [
                        {
                            amount: newAmountInDollars,
                            currency_code: "usd",
                            rules: {}
                        }
                    ]
                })
                stats.updatedPrice++

                if (stats.updatedPrice % 25 === 0) {
                    logger.info(`   ✅ Progress: ${stats.updatedPrice} prices updated...`)
                }
            } catch (err: any) {
                logger.error(`   ❌ ${variant.sku}: Price Update Failed - ${err.message}`)
            }
        }

        stats.foundInQb = qbVariants.length - stats.missingInQb

        logger.info(`\n${"=".repeat(50)}`)
        logger.info("✅ PRICE SYNC SUMMARY")
        logger.info(`${"=".repeat(50)}`)
        logger.info(`Total Linked Variants: ${stats.totalLinkedVariants}`)
        logger.info(`Found in QB:           ${stats.foundInQb}`)
        logger.info(`Missing in QB:         ${stats.missingInQb}`)
        logger.info(`Updated Prices:        ${stats.updatedPrice}`)
        logger.info(`Skipped (Unchanged):   ${stats.skippedNoChange}`)
        logger.info(`Skipped (No Price):    ${stats.skippedNoPrice}`)
        logger.info(`${"=".repeat(50)}\n`)

        return { success: true, stats }

    } catch (error: any) {
        logger.error(`❌ Sync failed: ${error.message}`)
        return { success: false, stats, error: error.message }
    }
}
