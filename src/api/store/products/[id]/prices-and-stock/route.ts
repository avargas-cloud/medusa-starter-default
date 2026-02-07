import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { getCacheManager } from "../../../../../lib/cache-manager"

/**
 * GET /store/products/:id/prices-and-stock
 * 
 * Lightweight endpoint for client-side price hydration in SSG pages.
 * Returns ONLY prices and inventory levels (no full product data).
 * 
 * PERFORMANCE: Uses direct Knex queries for speed (~40ms uncached, ~10ms cached)
 * CACHING: Results are cached for 5 minutes (300s) per product
 * 
 * @route GET /store/products/:id/prices-and-stock
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    try {
        const { id } = req.params

        // 🔥 CACHE LAYER: Check cache first
        const cacheKey = `product:${id}:prices-stock`
        const cacheService = req.scope.resolve("cache")
        const cacheManager = getCacheManager(cacheService)

        const cached = await cacheManager.get<any>(cacheKey)
        if (cached) {
            console.log(`[PRICES-STOCK] 🎯 Cache HIT: ${cacheKey}`)
            return res.json(cached)
        }

        console.log(`[PRICES-STOCK] ❌ Cache MISS: ${cacheKey}`)
        console.log(`[PRICES-STOCK] 💰 Fetching dynamic data for product: ${id}`)

        const knex = req.scope.resolve("__pg_connection__")

        // Fetch variant prices (direct Knex for speed)
        const prices = await knex("price")
            .select(
                "price.amount",
                "price.currency_code",
                "product_variant_price_set.variant_id",
                "product_variant.id as variant_id_full",
                "product_variant.title as variant_title",
                "product_variant.sku"
            )
            .join("product_variant_price_set", "price.price_set_id", "product_variant_price_set.price_set_id")
            .join("product_variant", "product_variant_price_set.variant_id", "product_variant.id")
            .where("product_variant.product_id", id)
            .where("price.currency_code", "usd")
            .whereNull("price.deleted_at")
            .whereNull("product_variant.deleted_at")

        console.log(`[PRICES-STOCK] 💵 Found ${prices.length} variant prices`)

        // Fetch inventory levels
        const inventory = await knex("inventory_level")
            .select(
                "inventory_level.stocked_quantity",
                "inventory_level.incoming_quantity",
                "inventory_level.reserved_quantity",
                "product_variant_inventory_item.variant_id"
            )
            .join("product_variant_inventory_item", "inventory_level.inventory_item_id", "product_variant_inventory_item.inventory_item_id")
            .join("product_variant", "product_variant_inventory_item.variant_id", "product_variant.id")
            .where("product_variant.product_id", id)
            .whereNull("inventory_level.deleted_at")
            .whereNull("product_variant.deleted_at")

        console.log(`[PRICES-STOCK] 📦 Found ${inventory.length} inventory records`)

        // Build variant data map
        const variantData = prices.map(p => {
            const inv = inventory.find(i => i.variant_id === p.variant_id)
            const availableQuantity = inv
                ? (inv.stocked_quantity || 0) - (inv.reserved_quantity || 0)
                : 0

            return {
                variant_id: p.variant_id,
                sku: p.sku,
                title: p.variant_title,
                price: {
                    amount: p.amount,
                    currency_code: p.currency_code,
                    // Medusa v2: prices are already in decimal format, no need to divide by 100
                    formatted: `$${parseFloat(p.amount).toFixed(2)}`
                },
                inventory: {
                    available: availableQuantity,
                    stocked: inv?.stocked_quantity || 0,
                    incoming: inv?.incoming_quantity || 0,
                    reserved: inv?.reserved_quantity || 0,
                    in_stock: availableQuantity > 0
                }
            }
        })

        console.log(`[PRICES-STOCK] ✅ Returning ${variantData.length} variants`)

        const responseData = {
            product_id: id,
            variants: variantData,
            timestamp: new Date().toISOString()
        }

        // 💾 CACHE: Store result for 5 minutes (300 seconds)
        await cacheManager.set(cacheKey, responseData, 300)
        console.log(`[PRICES-STOCK] 💾 Cached result: ${cacheKey}`)

        return res.json(responseData)

    } catch (error: any) {
        console.error("[PRICES-STOCK] ❌ Error:", error.message)
        return res.status(500).json({
            error: "Failed to fetch prices and stock",
            message: error.message
        })
    }
}
