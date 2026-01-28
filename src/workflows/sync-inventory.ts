import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"

export const syncInventoryToMeiliStep = createStep(
    "sync-to-meili-step",
    async (_, { container }) => {
        const { MeiliSearch } = await import("meilisearch")
        const query = container.resolve("query") as any

        // Initialize MeiliSearch client
        const client = new MeiliSearch({
            host: process.env.MEILISEARCH_HOST!,
            apiKey: process.env.MEILISEARCH_API_KEY!,
        })

        // Fetch all variants with their inventory items, prices, and product info
        const { data: variants } = await query.graph({
            entity: "product_variant",
            fields: [
                "id",
                "sku",
                "product.id",
                "product.title",
                "product.thumbnail",
                "product.status",
                "product.categories.id",
                "product.categories.handle",
                "product.categories.parent_category.handle",
                "product.categories.parent_category.parent_category.handle",
                "prices.amount",
                "prices.currency_code",
                "inventory_items.inventory.id",
                "inventory_items.inventory.sku",
                "inventory_items.inventory.title",
                "inventory_items.inventory.stocked_quantity",
                "inventory_items.inventory.reserved_quantity",
            ],
        })

        // Transform variants → inventory items for MeiliSearch
        const meiliInventoryItems = variants.flatMap((variant: any) => {
            const product = variant.product
            const priceObj = variant.prices?.[0]

            // Flatten all category handles (including parents)
            const allCategoryHandles = new Set<string>()
            product?.categories?.forEach((c: any) => {
                if (c.handle) allCategoryHandles.add(c.handle)
                if (c.parent_category?.handle) allCategoryHandles.add(c.parent_category.handle)
                if (c.parent_category?.parent_category?.handle) allCategoryHandles.add(c.parent_category.parent_category.handle)
            })

            // Map each inventory item linked to this variant
            return (variant.inventory_items || []).map((invItem: any) => {
                const inventory = invItem.inventory
                return {
                    id: inventory.id,
                    sku: inventory.sku || variant.sku || "",
                    title: inventory.title || product?.title || "Untitled",
                    thumbnail: product?.thumbnail || null,
                    totalStock: inventory.stocked_quantity || 0,
                    totalReserved: inventory.reserved_quantity || 0,
                    price: priceObj?.amount || 0, // v2: already in dollars
                    currencyCode: priceObj?.currency_code?.toUpperCase() || "USD",
                    variantId: variant.id,
                    productId: product?.id || null,
                    category_handles: Array.from(allCategoryHandles),
                    status: product?.status || "draft",
                }
            })
        })

        // Filter out orphaned items
        const validItems = meiliInventoryItems.filter((item: any) => item.variantId && item.productId)

        // Sync to MeiliSearch
        const index = client.index("inventory")

        // Update settings (idempotent, fast)
        await index.updateSettings({
            filterableAttributes: [
                "category_handles",
                "status",
                "id",
                "sku"
            ],
            sortableAttributes: [
                "title",
                "sku",
                "totalStock",
                "price",
                "totalReserved"
            ],
            searchableAttributes: [
                "title",
                "sku"
            ]
        })

        // Atomic replacement
        await index.deleteAllDocuments()
        const result = await index.addDocuments(validItems, { primaryKey: "id" })

        // BLOCKING: Wait for MeiliSearch to finish indexing before returning
        // This ensures the frontend gets fresh results immediately after this call succeeds
        await (client as any).tasks.waitForTask(result.taskUid)

        const withCategory = validItems.filter((i: any) => i.category_handles.length > 0)

        return new StepResponse({
            success: true,
            synced: validItems.length,
            itemsWithCategory: withCategory.length,
            taskUid: result.taskUid
        })
    }
)

export const syncInventoryWorkflow = createWorkflow(
    "sync-inventory-workflow",
    () => {
        const result = syncInventoryToMeiliStep()
        return new WorkflowResponse(result)
    }
)
