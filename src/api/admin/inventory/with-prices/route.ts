import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * GET /admin/inventory/with-prices
 * 
 * Uses Remote Query (Query Graph) to fetch inventory items with prices
 * This is the CORRECT approach for Medusa v2 - traverses module boundaries
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    try {
        // 1. Resolve the Query service (the engine that connects modules)
        const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

        // 2. Execute Query Graph
        // Request "inventory_items" and tell it to "walk" through the Link to "variants"
        const { data: inventoryItems, metadata } = await query.graph({
            entity: "inventory_item",
            fields: [
                "id",
                "sku",
                "title",
                "stocked_quantity",
                "reserved_quantity",
                // HERE'S THE MAGIC: Fetch associated variant and its prices
                "variants.id",
                "variants.title",
                "variants.prices.amount",
                "variants.prices.currency_code",
                "variants.product.id",        // for variant navigation
                "variants.product.title",     // for product context
                "variants.product.categories.id" // NEW: for category filtering
            ],
            // 3. Pass pagination config from frontend (limit, offset)
            ...req.queryConfig,
        })

        console.log("✅ Query Graph executed, items:", inventoryItems?.length)

        // 4. Data mapping (flatten structure for frontend)
        const flattenedItems = inventoryItems?.map((item: any) => {
            // Take first variant (usually 1:1 in simple inventory)
            const primaryVariant = item.variants?.[0]
            // Take first price (or search for specific currency if needed)
            const priceObj = primaryVariant?.prices?.[0]

            return {
                id: item.id,
                sku: item.sku || "",
                title: item.title || item.sku || "Untitled",
                totalStock: item.stocked_quantity || 0,
                totalReserved: item.reserved_quantity || 0,
                variantId: primaryVariant?.id,
                productId: primaryVariant?.product?.id,
                productCategoryId: primaryVariant?.product?.categories?.[0]?.id, // NEW: for filtering
                price: priceObj ? {
                    amount: priceObj.amount,
                    currencyCode: priceObj.currency_code?.toUpperCase() || "USD"
                } : undefined,
                variant_title: primaryVariant?.title || "-"
            }
        }) || []

        console.log("💰 Items with prices:", flattenedItems.filter((i: any) => i.price).length)
        console.log("📊 Sample item:", flattenedItems[0])

        res.json({
            items: flattenedItems,
            count: metadata?.count || flattenedItems.length,
        })

    } catch (error: any) {
        console.error("❌ Query Graph Error:", error)
        res.status(500).json({
            message: "Failed to fetch inventory with prices",
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        })
    }
}

// Admin authentication
export const AUTHENTICATE = ["user"]
