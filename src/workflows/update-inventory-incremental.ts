import { createWorkflow, createStep, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk"

interface UpdateInventoryIncrementalInput {
    variantId?: string
    productId?: string
}

/**
 * INCREMENTAL SYNC: Update Inventory for Product/Variant
 * 
 * Updates inventory items affected by a product or variant change.
 * Unlike full sync, only updates relevant inventory entries.
 */

const updateInventoryIncrementalStep = createStep(
    "update-inventory-incremental-step",
    async ({ variantId, productId }: UpdateInventoryIncrementalInput, { container }) => {
        const logger = container.resolve("logger")
        const query = container.resolve("query")

        try {
            // Dynamic import for ESM compatibility
            const { MeiliSearch } = await import("meilisearch")

            // 1. Determine which variants to sync
            let variantIds: string[] = []

            if (variantId) {
                variantIds = [variantId]
            } else if (productId) {
                // Get all variants for this product
                const { data: variants } = await query.graph({
                    entity: "product_variant",
                    fields: ["id"],
                    filters: { product_id: productId }
                })
                variantIds = variants?.map((v: any) => v.id) || []
            }

            if (variantIds.length === 0) {
                logger.warn(`[MEILI-INVENTORY-INCREMENTAL] No variants to sync`)
                return new StepResponse({ success: false, itemsUpdated: 0 })
            }

            // 2. Fetch variants with all data
            const { data: variants } = await query.graph({
                entity: "product_variant",
                fields: [
                    "id",
                    "title",
                    "sku",
                    "barcode",
                    "updated_at",
                    "product.id",
                    "product.title",
                    "product.thumbnail",
                    "product.status",
                    "product.handle",
                    "product.categories.handle",
                    "prices.amount",
                    "prices.currency_code",
                    "prices.price_list_id",
                    "inventory_items.inventory.id",
                    "inventory_items.inventory.title",
                    "inventory_items.inventory.sku",
                    "inventory_items.inventory.location_levels.stocked_quantity",
                    "inventory_items.inventory.location_levels.reserved_quantity",
                    "inventory_items.inventory.updated_at"
                ],
                filters: { id: variantIds }
            })

            // 3. Transform to inventory items
            const inventoryItems = variants.flatMap((variant: any) => {
                return variant.inventory_items?.map((invItem: any) => {
                    const inventory = invItem.inventory
                    if (!inventory || !variant.product?.id) return null

                    const locationLevels = inventory.location_levels || []
                    const totalStock = locationLevels.reduce((sum: number, level: any) =>
                        sum + (level.stocked_quantity || 0), 0)
                    const totalReserved = locationLevels.reduce((sum: number, level: any) =>
                        sum + (level.reserved_quantity || 0), 0)

                    const firstPrice = variant.prices?.[0]

                    return {
                        id: inventory.id,
                        sku: inventory.sku || variant.sku || "",
                        title: variant.title || inventory.title || "",
                        totalStock,
                        totalReserved,
                        price: firstPrice?.amount || 0,
                        currencyCode: firstPrice?.currency_code || "USD",
                        variantId: variant.id,
                        productId: variant.product.id,
                        status: variant.product.status || "draft",
                        category_handles: variant.product.categories?.map((c: any) => c.handle) || [],
                        thumbnail: variant.product.thumbnail || "",
                        created_at: new Date(inventory.created_at || Date.now()).getTime(),
                        updated_at: new Date(inventory.updated_at || Date.now()).getTime()
                    }
                }).filter(Boolean) || []
            })

            if (inventoryItems.length === 0) {
                logger.warn(`[MEILI-INVENTORY-INCREMENTAL] No inventory items found for variants`)
                return new StepResponse({ success: false, itemsUpdated: 0 })
            }

            // 4. Update in MeiliSearch
            const client = new MeiliSearch({
                host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
                apiKey: process.env.MEILISEARCH_API_KEY || "masterKey"
            })

            const index = client.index("inventory")
            const result = await index.addDocuments(inventoryItems, { primaryKey: "id" })

            // 5. Wait for indexing to complete
            await (client as any).tasks.waitForTask(result.taskUid)

            logger.info(`[MEILI-INVENTORY-INCREMENTAL] ✅ Updated ${inventoryItems.length} items`)

            return new StepResponse({
                success: true,
                itemsUpdated: inventoryItems.length
            })

        } catch (error: any) {
            logger.error(`[MEILI-INVENTORY-INCREMENTAL] ❌ Failed:`, error.message)
            return new StepResponse({ success: false, itemsUpdated: 0 })
        }
    }
)

export const updateInventoryIncrementalWorkflow = createWorkflow(
    "update-inventory-incremental",
    (input: UpdateInventoryIncrementalInput) => {
        const result = updateInventoryIncrementalStep(input)
        return new WorkflowResponse(result)
    }
)
