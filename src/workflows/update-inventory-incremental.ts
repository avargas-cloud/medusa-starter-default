import { createWorkflow, createStep, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { MeiliSearch } from "meilisearch"

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
                return new StepResponse({ success: false, reason: "no_variants" })
            }

            // 2. Fetch variants with all data
            const { data: variants } = await query.graph({
                entity: "product_variant",
                fields: [
                    "id",
                    "title",
                    "sku",
                    "barcode",
                    "created_at",
                    "updated_at",
                    "product.id",
                    "product.title",
                    "product.thumbnail",
                    "product.categories.handle",
                    "product.status",
                    "inventory_items.inventory.id",
                    "inventory_items.inventory.created_at",
                    "inventory_items.inventory.updated_at",
                    "inventory_items.inventory.location_id",
                    "inventory_items.inventory.stocked_quantity",
                    "inventory_items.inventory.reserved_quantity"
                ],
                filters: { id: variantIds }
            })

            if (!variants || variants.length === 0) {
                logger.warn(`[MEILI-INVENTORY-INCREMENTAL] Variants not found`)
                return new StepResponse({ success: false, reason: "not_found" })
            }

            // 3. Initialize MeiliSearch client
            const client = new MeiliSearch({
                host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
                apiKey: process.env.MEILISEARCH_API_KEY || "masterKey"
            })

            // 4. Transform variants to inventory items
            const meiliInventoryItems = variants.map((variant: any) => {
                const inventoryLevels = variant.inventory_items?.flatMap((ii: any) => ii.inventory || []) || []
                const totalStock = inventoryLevels.reduce((sum: number, level: any) =>
                    sum + (level.stocked_quantity || 0), 0)
                const totalReserved = inventoryLevels.reduce((sum: number, level: any) =>
                    sum + (level.reserved_quantity || 0), 0)

                // Get latest updated_at from inventory items or variant
                const inventoryUpdates = inventoryLevels.map((inv: any) => new Date(inv.updated_at || 0).getTime())
                const latestInventoryUpdate = Math.max(...inventoryUpdates, 0)
                const variantUpdate = new Date(variant.updated_at || 0).getTime()
                const finalUpdatedAt = Math.max(latestInventoryUpdate, variantUpdate)

                return {
                    id: variant.id,
                    variantId: variant.id,
                    productId: variant.product?.id || "",
                    title: `${variant.product?.title || "Unknown"} - ${variant.title || ""}`.trim(),
                    sku: variant.sku || "",
                    barcode: variant.barcode || "",
                    thumbnail: variant.product?.thumbnail || null,
                    category_handles: variant.product?.categories?.map((c: any) => c.handle).filter(Boolean) || [],
                    status: variant.product?.status || "draft",
                    totalStock,
                    totalReserved,
                    availableStock: totalStock - totalReserved,
                    created_at: new Date(variant.created_at || 0).getTime(),
                    updated_at: finalUpdatedAt
                }
            })

            // Filter out invalid items
            const validItems = meiliInventoryItems.filter(item => item.variantId && item.productId)

            if (validItems.length === 0) {
                logger.warn(`[MEILI-INVENTORY-INCREMENTAL] No valid items to sync`)
                return new StepResponse({ success: false, reason: "no_valid_items" })
            }

            // 5. Update in MeiliSearch
            const index = client.index("inventory")
            const result = await index.addDocuments(validItems, { primaryKey: "id" })

            // 6. Wait for indexing to complete
            await (client as any).tasks.waitForTask(result.taskUid)

            logger.info(`[MEILI-INVENTORY-INCREMENTAL] ✅ Updated ${validItems.length} inventory items`)

            return new StepResponse({
                success: true,
                itemsUpdated: validItems.length
            })

        } catch (error: any) {
            logger.error(`[MEILI-INVENTORY-INCREMENTAL] ❌ Failed:`, error.message)
            return new StepResponse({ success: false, error: error.message })
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
