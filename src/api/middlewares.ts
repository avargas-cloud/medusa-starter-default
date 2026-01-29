import { defineMiddlewares } from "@medusajs/medusa"
import type { MedusaRequest, MedusaResponse, MedusaNextFunction } from "@medusajs/framework/http"
import { scheduleCategoryUpdate } from "../lib/category-attributes-sync"

/**
 * Category Available Attributes Auto-Sync Middleware
 * 
 * Intercepts product update/create responses and updates category.metadata.available_attributes
 * This keeps the Filters UI fast by pre-calculating which attributes exist in each category.
 * 
 * Pattern based on MEDUSA_V2_SUBSCRIBER_BUG_AND_MIDDLEWARE_FIX.md
 */
async function syncCategoryAttributesMiddleware(
    req: MedusaRequest,
    res: MedusaResponse,
    next: MedusaNextFunction
) {
    // ⭐ CRITICAL: Skip GET requests (searches, listings) - only intercept writes
    if (req.method === "GET") {
        return next()
    }

    console.log(`🔍 [MIDDLEWARE] Intercepting: ${req.method} ${req.url}`)

    // Save original res.json function
    const originalJson = res.json.bind(res)

    // Wrap res.json to intercept responses
    res.json = (data: any) => {
        console.log(`📤 [MIDDLEWARE] Response has product:`, !!data?.product, `products:`, !!data?.products)
        // Detect single product in response
        if (data?.product) {
            // Use setImmediate to not block HTTP response
            setImmediate(async () => {
                try {
                    // Fetch complete product with categories
                    const productModule = (req as any).scope.resolve("product")
                    const [fullProduct] = await productModule.listProducts(
                        { id: [data.product.id] },
                        { relations: ["categories", "variants"] }
                    )

                    if (!fullProduct || !fullProduct.categories) {
                        return
                    }

                    // Schedule update for each category (debounced)
                    for (const category of fullProduct.categories) {
                        scheduleCategoryUpdate(category.id, (req as any).scope, req.headers)
                    }

                    console.log(`🔄 [CATEGORY-ATTRS] Scheduled update for ${fullProduct.categories.length} categories`)
                } catch (error: any) {
                    console.error(`❌ [CATEGORY-ATTRS] Middleware error:`, error.message)
                }
            })
        }

        // Detect bulk products in response
        else if (data?.products && Array.isArray(data.products)) {
            setImmediate(async () => {
                try {
                    const productModule = (req as any).scope.resolve("product")
                    const ids = data.products.map((p: any) => p.id)

                    const fullProducts = await productModule.listProducts(
                        { id: ids },
                        { relations: ["categories", "variants"] }
                    )

                    const categoryIds = new Set<string>()

                    for (const product of fullProducts) {
                        if (product.categories) {
                            product.categories.forEach((cat: any) => categoryIds.add(cat.id))
                        }
                    }

                    for (const catId of categoryIds) {
                        scheduleCategoryUpdate(catId, (req as any).scope, req.headers)
                    }

                    console.log(`🔄 [CATEGORY-ATTRS] Scheduled update for ${categoryIds.size} categories from ${fullProducts.length} products`)
                } catch (error: any) {
                    console.error(`❌ [CATEGORY-ATTRS] Bulk middleware error:`, error.message)
                }
            })
        }

        // Call original res.json (client gets normal response)
        return originalJson(data)
    }

    // Continue middleware chain
    next()
}

export default defineMiddlewares({
    routes: [
        {
            matcher: "/admin/products*",
            middlewares: [syncCategoryAttributesMiddleware],
        },
    ],
})
