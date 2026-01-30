import { defineMiddlewares } from "@medusajs/medusa"
import type { MedusaRequest, MedusaResponse, MedusaNextFunction } from "@medusajs/framework/http"

/**
 * AUTO-SYNC AVAILABLE ATTRIBUTES MIDDLEWARE
 * 
 * Why middleware instead of subscribers?
 * - Medusa v2 subscribers are broken (module isolation bug)
 * - HTTP middleware is the proven production pattern
 * - See docs/MEDUSA_V2_SUBSCRIBER_BUG_AND_MIDDLEWARE_FIX.md
 * 
 * This middleware intercepts HTTP responses and triggers category sync
 * when products are created/updated/deleted.
 */
async function syncCategoryAttributesMiddleware(
    req: MedusaRequest,
    res: MedusaResponse,
    next: MedusaNextFunction
) {
    // Step 1: Save original res.json function
    const originalJson = res.json.bind(res)

    // Step 2: Wrap with our detection logic
    res.json = (data: any) => {
        // Detect if response contains product(s)
        const hasProduct = data?.product
        const hasProducts = data?.products && Array.isArray(data.products)

        if (hasProduct || hasProducts) {
            // ⭐ ASYNC: Don't block HTTP response
            setImmediate(async () => {
                try {
                    const basePath = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000"
                    const query = (req as any).scope.resolve("query")

                    // Extract product IDs
                    const productIds = hasProducts
                        ? data.products.map((p: any) => p.id)
                        : [data.product.id]

                    // Fetch products with categories
                    const result = await query.graph({
                        entity: "product",
                        fields: ["id", "categories.id"],
                        filters: { id: productIds }
                    })

                    const products = result?.data || []

                    // Collect unique category IDs
                    const categoryIds = new Set<string>()
                    products.forEach((product: any) => {
                        if (product.categories) {
                            product.categories.forEach((cat: any) => {
                                if (cat?.id) categoryIds.add(cat.id)
                            })
                        }
                    })

                    if (categoryIds.size === 0) {
                        console.log(`[CATEGORY-ATTR-SYNC] No categories affected by product changes`)
                        return
                    }

                    // Sync each affected category
                    console.log(`[CATEGORY-ATTR-SYNC] Syncing ${categoryIds.size} categories for ${products.length} product(s)`)

                    for (const categoryId of categoryIds) {
                        try {
                            const response = await fetch(`${basePath}/admin/product-categories/${categoryId}/sync-attributes`, {
                                method: "POST",
                                headers: {
                                    "Content-Type": "application/json"
                                }
                            })

                            if (response.ok) {
                                const result = await response.json()
                                console.log(`[CATEGORY-ATTR-SYNC] ✅ Category ${categoryId}: ${result.attributeCount} attributes`)
                            } else {
                                console.warn(`[CATEGORY-ATTR-SYNC] ⚠️  Category ${categoryId} sync failed: ${response.status}`)
                            }
                        } catch (error: any) {
                            console.error(`[CATEGORY-ATTR-SYNC] ❌ Category ${categoryId} error:`, error.message)
                        }
                    }

                } catch (error: any) {
                    console.error("[CATEGORY-ATTR-SYNC] ❌ Middleware error:", error.message)
                }
            })
        }

        // Step 3: Call original (client gets normal response)
        return originalJson(data)
    }

    // Step 4: Continue middleware chain
    next()
}

export default defineMiddlewares({
    routes: [
        {
            // ⭐ WILDCARD PATTERN: Covers all product endpoints
            // - POST /admin/products (create)
            // - POST /admin/products/:id (update)
            // - DELETE /admin/products/:id (delete)
            // - POST /admin/products/:id/variants (add variant)
            // - Bulk operations
            matcher: "/admin/products*",
            middlewares: [syncCategoryAttributesMiddleware],
        },
    ],
})

