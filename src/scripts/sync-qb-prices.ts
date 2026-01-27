import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { IPricingModuleService } from "@medusajs/types"

// Config
const BRIDGE_URL = "https://ecopower-qb.loca.lt"
const API_KEY = "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD"
const POLL_INTERVAL_MS = 30000 // 30 seconds
const MAX_POLL_ATTEMPTS = 20 // 10 minutes max

/**
 * Sync ONLY PRICES from QuickBooks
 * Run: yarn medusa exec ./src/scripts/sync-qb-prices.ts
 * Schedule: 1x per day (night)
 */
export default async function syncQbPrices({ container }: ExecArgs) {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const pricingModule: IPricingModuleService = container.resolve(Modules.PRICING)
    const query = container.resolve(ContainerRegistrationKeys.QUERY)

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
    logger.info(`📊 Found ${qbVariants.length} variants linked to QuickBooks.`)

    if (qbVariants.length === 0) {
        logger.info("⚠️ No linked products found. Run 'assign-quickbooks-ids' first.")
        return
    }

    // 2. Initiate Bulk Sync
    logger.info("📡 Requesting Bulk Data from Bridge...")
    const initRes = await fetch(`${BRIDGE_URL}/api/products`, {
        headers: { "x-api-key": API_KEY }
    })

    if (!initRes.ok) {
        logger.error(`❌ Bridge Error: ${initRes.status} ${initRes.statusText}`)
        return
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
                logger.error(`❌ QB sync failed: ${statusJson.operation.error || "Unknown"}`)
                return
            }
        }
    }

    if (qbData.length === 0) {
        logger.error("❌ No data received after polling timeout.")
        return
    }

    // 4. Update ONLY Prices (with comparison)
    logger.info("\n💵 Processing Price Updates...")
    let updatedPrice = 0
    let skippedNoChange = 0
    let skippedNoPrice = 0
    let missingInQb = 0

    const qbMap = new Map(qbData.map((item: any) => [item.ListID, item]))

    for (const variant of qbVariants) {
        const qbId = (variant.metadata as any)?.quickbooks_id
        const qbItem = qbMap.get(qbId)

        if (!qbItem) {
            missingInQb++
            logger.warn(`   ⚠️ ${variant.sku} not found in QB Response.`)
            continue
        }

        const newPrice = parseFloat(qbItem.SalesPrice)

        if (!variant.price_set) {
            skippedNoPrice++
            logger.warn(`   ❌ ${variant.sku}: No Price Set linked.`)
            continue
        }

        if (isNaN(newPrice)) {
            skippedNoPrice++
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

            // v2: Price is already in dollars, no conversion needed
            const newAmountInDollars = newPrice // QB sends dollars

            // Compare: Skip if unchanged (v2 format - dollars)
            if (currentAmount === newAmountInDollars) {
                skippedNoChange++
                continue
            }

            // Update Price (v2: store in dollars directly)
            await pricingModule.updatePriceSets(variant.price_set.id, {
                prices: [
                    {
                        amount: newAmountInDollars, // v2: NO × 100 multiplication
                        currency_code: "usd",
                        rules: {}
                    }
                ]
            })
            updatedPrice++

            if (updatedPrice % 25 === 0) {
                logger.info(`   ✅ Progress: ${updatedPrice} prices updated...`)
            }
        } catch (err: any) {
            logger.error(`   ❌ ${variant.sku}: Price Update Failed - ${err.message}`)
        }
    }

    logger.info(`\n${"=".repeat(50)}`)
    logger.info("✅ PRICE SYNC SUMMARY")
    logger.info(`${"=".repeat(50)}`)
    logger.info(`Total Linked Variants: ${qbVariants.length}`)
    logger.info(`Found in QB:           ${qbVariants.length - missingInQb}`)
    logger.info(`Missing in QB:         ${missingInQb}`)
    logger.info(`Updated Prices:        ${updatedPrice}`)
    logger.info(`Skipped (Unchanged):   ${skippedNoChange}`)
    logger.info(`Skipped (No Price):    ${skippedNoPrice}`)
    logger.info(`${"=".repeat(50)}\n`)
}
