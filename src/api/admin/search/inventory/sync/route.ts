import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

/**
 * POST /admin/search/inventory/sync
 * 
 * Synchronize all inventory items to MeiliSearch index
 * Called automatically when Inventory-Advanced page loads
 */
export const POST = async (
    req: MedusaRequest,
    res: MedusaResponse
) => {
    try {
        const { MeiliSearch } = await import("meilisearch")
        const query = req.scope.resolve("query")

        // Initialize MeiliSearch client
        const client = new MeiliSearch({
            host: process.env.MEILISEARCH_HOST!,
            apiKey: process.env.MEILISEARCH_API_KEY!,
        })

        // Fetch all variants with their inventory items, prices, and product info
        // Strategy: Query from variant → inventory_item (not inventory_item → variant)
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
        // Each variant can have multiple inventory_items, so we flatten
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

        // Filter out orphaned items (no variant/product associated)
        const validItems = meiliInventoryItems.filter((item: any) => item.variantId && item.productId)
        const orphanedCount = meiliInventoryItems.length - validItems.length

        // if (orphanedCount > 0) {
        //     console.log(`⚠️  Skipped ${orphanedCount} orphaned inventory items (no variant/product)`)
        // }

        // Sync to MeiliSearch
        const index = client.index("inventory")

        // CRITICAL: Delete all existing documents to avoid mixing old/new schema
        await index.deleteAllDocuments()
        // console.log("🗑️  Cleared existing inventory documents")

        // CRITICAL: Update settings to allow filtering and sorting
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
                "price"
            ],
            searchableAttributes: [
                "title",
                "sku"
            ]
        })

        const result = await index.addDocuments(validItems, { primaryKey: "id" })

        // Diagnostic logging
        const withCategory = validItems.filter((i: any) => i.category_handles.length > 0)
        const categoryStats = withCategory.reduce((acc: any, item: any) => {
            item.category_handles.forEach((handle: string) => {
                acc[handle] = (acc[handle] || 0) + 1
            })
            return acc
        }, {})

        // console.log(`✅ Synced ${validItems.length} inventory items to MeiliSearch`)
        // console.log(`   Items with category: ${withCategory.length}`)
        // console.log(`   Items without category: ${validItems.length - withCategory.length}`)
        // console.log(`   Category distribution:`, categoryStats)

        return res.json({
            success: true,
            synced: validItems.length,
            itemsWithCategory: withCategory.length,
            categoryStats,
            taskUid: result.taskUid,
        })

    } catch (error: any) {
        console.error("[MeiliSearch Inventory Sync Error]:", error.message)

        return res.status(500).json({
            success: false,
            error: "Sync failed",
            message: error.message,
        })
    }
}

// Middleware to protect this route (admin only)
export const AUTHENTICATE = ["user"]
