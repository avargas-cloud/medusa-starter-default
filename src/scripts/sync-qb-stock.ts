import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { IInventoryService, IStockLocationService } from "@medusajs/types"

// Config
const BRIDGE_URL = "https://ecopower-qb.loca.lt"
const API_KEY = "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD"
const POLL_INTERVAL_MS = 30000 // 30 seconds
const MAX_POLL_ATTEMPTS = 20 // 10 minutes max

/**
 * Sync ONLY STOCK from QuickBooks
 * Run: yarn medusa exec ./src/scripts/sync-qb-stock.ts
 * Schedule: Frequently (e.g. every 15-30 mins)
 */
export default async function syncQbStock({ container }: ExecArgs) {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const inventoryService: IInventoryService = container.resolve(Modules.INVENTORY)
    const stockLocationService: IStockLocationService = container.resolve(Modules.STOCK_LOCATION)
    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    logger.info(`📦 Starting QuickBooks STOCK Sync (ONLY)...`)

    // 1. Get Default Stock Location
    const locations = await stockLocationService.listStockLocations({}, { take: 1 })

    if (locations.length === 0) {
        logger.error("❌ No Stock Location found! Create one in Medusa Settings first.")
        return
    }
    const locationId = locations[0].id
    logger.info(`📍 Using Stock Location: ${locations[0].name} (${locationId})`)

    // 2. Fetch Medusa Products with QB ID
    logger.info("🔍 Fetching Medusa Products with QuickBooks ID...")
    const { data: variants } = await query.graph({
        entity: "variant",
        fields: [
            "id",
            "sku",
            "metadata",
            "inventory_items.inventory_item_id"
        ]
    })

    const qbVariants = variants.filter((v: any) => v.metadata?.quickbooks_id)
    logger.info(`📊 Found ${qbVariants.length} variants linked to QuickBooks.`)

    if (qbVariants.length === 0) {
        logger.info("⚠️ No linked products found. Run 'assign-quickbooks-ids' first.")
        return
    }

    // 3. Initiate Bulk Sync
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

    // 4. Polling Loop
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

    // 5. Update ONLY Stock (with comparison)
    logger.info("\n📦 Processing Stock Updates...")
    let updatedStock = 0
    let skippedNoChange = 0
    let skippedNoInventory = 0
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

        const newStock = parseInt(qbItem.QuantityOnHand)

        let inventoryItemId = variant.inventory_items?.[0]?.inventory_item_id

        if (!inventoryItemId) {
            skippedNoInventory++
            logger.warn(`   ❌ ${variant.sku}: No Inventory Item linked.`)
            continue
        }

        if (isNaN(newStock)) {
            logger.warn(`   ⚠️ ${variant.sku}: Invalid stock in QB`)
            continue
        }

        // Get current stock to compare
        try {
            const levels = await inventoryService.listInventoryLevels({
                inventory_item_id: inventoryItemId,
                location_id: locationId
            })

            if (levels.length > 0) {
                const currentStock = levels[0].stocked_quantity

                // Compare: Skip if unchanged
                if (currentStock === newStock) {
                    skippedNoChange++
                    continue
                }

                // Update existing level
                await inventoryService.updateInventoryLevels({
                    id: levels[0].id,
                    inventory_item_id: inventoryItemId,
                    location_id: locationId,
                    stocked_quantity: newStock
                })
            } else {
                // Create new level (first time)
                await inventoryService.createInventoryLevels({
                    inventory_item_id: inventoryItemId,
                    location_id: locationId,
                    stocked_quantity: newStock,
                    incoming_quantity: 0
                })
            }
            updatedStock++

            if (updatedStock % 25 === 0) {
                logger.info(`   ✅ Progress: ${updatedStock} stock levels updated...`)
            }
        } catch (err: any) {
            logger.error(`   ❌ ${variant.sku}: Stock Update Failed - ${err.message}`)
        }
    }

    logger.info(`\n${"=".repeat(50)}`)
    logger.info("✅ STOCK SYNC SUMMARY")
    logger.info(`${"=".repeat(50)}`)
    logger.info(`Total Linked Variants: ${qbVariants.length}`)
    logger.info(`Found in QB:           ${qbVariants.length - missingInQb}`)
    logger.info(`Missing in QB:         ${missingInQb}`)
    logger.info(`Updated Stock:         ${updatedStock}`)
    logger.info(`Skipped (Unchanged):   ${skippedNoChange}`)
    logger.info(`Skipped (No Inv):      ${skippedNoInventory}`)
    logger.info(`${"=".repeat(50)}\n`)
}
