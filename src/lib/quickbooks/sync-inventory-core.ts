import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { IInventoryService, IStockLocationService } from "@medusajs/types"

// Config
const BRIDGE_URL = "https://ecopower-qb.loca.lt"
const API_KEY = "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD"
const POLL_INTERVAL_MS = 30000 // 30 seconds
const MAX_POLL_ATTEMPTS = 20 // 10 minutes max

export interface SyncInventoryResult {
    success: boolean
    stats: {
        totalLinkedVariants: number
        foundInQb: number
        missingInQb: number
        updatedStock: number
        skippedNoInventoryItem: number
    }
    error?: string
}

/**
 * Core logic for syncing inventory levels from QuickBooks
 * Can be called from CLI or API
 */
export async function syncInventoryCore(container: any): Promise<SyncInventoryResult> {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const inventoryService: IInventoryService = container.resolve(Modules.INVENTORY)
    const stockLocationService: IStockLocationService = container.resolve(Modules.STOCK_LOCATION)
    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    const stats = {
        totalLinkedVariants: 0,
        foundInQb: 0,
        missingInQb: 0,
        updatedStock: 0,
        skippedNoInventoryItem: 0
    }

    try {
        logger.info(`📦 Starting QuickBooks INVENTORY Sync (ONLY)...`)

        // 1. Get Default Stock Location
        const locations = await stockLocationService.listStockLocations({}, { take: 1 })

        if (locations.length === 0) {
            const error = "No Stock Location found! Create one in Medusa Settings first."
            logger.error(`❌ ${error}`)
            return { success: false, stats, error }
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
                "title",
                "metadata",
                "inventory_items.inventory_item_id"
            ]
        })

        const qbVariants = variants.filter((v: any) => v.metadata?.quickbooks_id)
        stats.totalLinkedVariants = qbVariants.length
        logger.info(`📊 Found ${qbVariants.length} variants linked to QuickBooks.`)

        if (qbVariants.length === 0) {
            logger.info("⚠️ No linked products found. Run 'assign-quickbooks-ids' first.")
            return { success: false, stats, error: "No linked products found" }
        }

        // 3. Initiate Bulk Sync
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
                    // Parse data from XML or JSON
                    const rawXml = statusJson.operation.qbxmlResponse
                    if (rawXml) {
                        logger.info("📦 Received Raw XML. Parsing...")
                        const itemBlocks = rawXml.match(/<Item[a-zA-Z]+Ret>[\s\S]*?<\/Item[a-zA-Z]+Ret>/g) || []

                        qbData = itemBlocks.map((block: string) => {
                            const listId = block.match(/<ListID>([^<]+)<\/ListID>/)?.[1]
                            const stock = block.match(/<QuantityOnHand>([^<]+)<\/QuantityOnHand>/)?.[1]
                            const name = block.match(/<Name>([^<]+)<\/Name>/)?.[1]

                            return {
                                ListID: listId,
                                QuantityOnHand: stock,
                                Name: name
                            }
                        }).filter((i: any) => i.ListID)

                        logger.info(`🎉 Parsed ${qbData.length} items from XML.`)
                    } else {
                        qbData = statusJson.data || []
                    }

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

        // 5. Update ONLY Inventory
        logger.info("\n📦 Processing Inventory Updates...")

        const qbMap = new Map(qbData.map((item: any) => [item.ListID, item]))

        for (const variant of qbVariants) {
            const qbId = (variant.metadata as any)?.quickbooks_id
            const qbItem = qbMap.get(qbId)

            if (!qbItem) {
                stats.missingInQb++
                logger.warn(`   ⚠️ ${variant.sku} not found in QB Response.`)
                continue
            }

            const newStock = parseInt(qbItem.QuantityOnHand)
            const inventoryItemId = variant.inventory_items?.[0]?.inventory_item_id

            if (!inventoryItemId) {
                stats.skippedNoInventoryItem++
                logger.warn(`   ❌ ${variant.sku}: No Inventory Item linked.`)
                continue
            }

            if (isNaN(newStock)) {
                logger.warn(`   ⚠️ ${variant.sku}: Invalid stock in QB`)
                continue
            }

            try {
                // Check if inventory level exists
                const levels = await inventoryService.listInventoryLevels({
                    inventory_item_id: inventoryItemId,
                    location_id: locationId
                })

                if (levels.length > 0) {
                    await inventoryService.updateInventoryLevels({
                        id: levels[0].id,
                        inventory_item_id: inventoryItemId,
                        location_id: locationId,
                        stocked_quantity: newStock
                    })
                } else {
                    await inventoryService.createInventoryLevels({
                        inventory_item_id: inventoryItemId,
                        location_id: locationId,
                        stocked_quantity: newStock,
                        incoming_quantity: 0
                    })
                }

                stats.updatedStock++

                if (stats.updatedStock % 25 === 0) {
                    logger.info(`   ✅ Progress: ${stats.updatedStock} items updated...`)
                }
            } catch (err: any) {
                logger.error(`   ❌ ${variant.sku}: Inventory Update Failed - ${err.message}`)
            }
        }

        stats.foundInQb = qbVariants.length - stats.missingInQb

        logger.info(`\n${"=".repeat(50)}`)
        logger.info("✅ INVENTORY SYNC SUMMARY")
        logger.info(`${"=".repeat(50)}`)
        logger.info(`Total Linked Variants:  ${stats.totalLinkedVariants}`)
        logger.info(`Found in QB:            ${stats.foundInQb}`)
        logger.info(`Missing in QB:          ${stats.missingInQb}`)
        logger.info(`Updated Inventory:      ${stats.updatedStock}`)
        logger.info(`Skipped (No Inv Item):  ${stats.skippedNoInventoryItem}`)
        logger.info(`${"=".repeat(50)}\n`)

        return { success: true, stats }

    } catch (error: any) {
        logger.error(`❌ Sync failed: ${error.message}`)
        return { success: false, stats, error: error.message }
    }
}
