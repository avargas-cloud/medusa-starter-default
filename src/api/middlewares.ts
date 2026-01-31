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
    // ⚡ ONLY run on mutation operations (POST, PUT, DELETE)
    const method = req.method?.toUpperCase()
    if (method !== 'POST' && method !== 'PUT' && method !== 'DELETE') {
        return next()
    }

    // Step 1: Save original res.json function
    const originalJson = res.json.bind(res)

    // Step 2: Wrap with our detection logic
    res.json = (data: any) => {
        // Detect if response contains product(s) OR if this is an /attributes update
        const hasProduct = data?.product
        const hasProducts = data?.products && Array.isArray(data.products)
        const isAttributesUpdate = req.path?.includes('/attributes') && method === 'POST'

        if (hasProduct || hasProducts || isAttributesUpdate) {
            // ⭐ ASYNC: Don't block HTTP response
            setImmediate(async () => {
                try {
                    const basePath = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000"
                    const query = (req as any).scope.resolve("query")

                    // Extract product IDs
                    let productIds: string[]
                    if (isAttributesUpdate) {
                        // For /attributes endpoint, get product ID from URL params
                        productIds = [req.params.id as string]
                    } else if (hasProducts) {
                        productIds = data.products.map((p: any) => p.id)
                    } else {
                        productIds = [data.product.id]
                    }

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
                    console.log(`[CATEGORY-ATTR-SYNC] 🎯 Intercepted response for product(s): ${productIds.join(', ')}`)
                    console.log(`[CATEGORY-ATTR-SYNC] 📂 Found ${categoryIds.size} categories to sync`)

                    try {
                        const syncBasePath = `http://localhost:${process.env.PORT || 9000}`

                        for (const categoryId of categoryIds) {
                            console.log(`[CATEGORY-ATTR-SYNC] 🔄 Syncing category: ${categoryId}`)
                            try {
                                const response = await fetch(`${syncBasePath}/admin/product-categories/${categoryId}/sync-attributes`, {
                                    method: "POST",
                                    headers: {
                                        "Content-Type": "application/json",
                                        "Cookie": req.headers.cookie || "",
                                        "Authorization": req.headers.authorization || ""
                                    }
                                })

                                if (response.ok) {
                                    const result = await response.json()
                                    console.log(`[CATEGORY-ATTR-SYNC] ✅ Category ${categoryId}: ${result.filterCount} filters`)
                                } else {
                                    const errorText = await response.text()
                                    console.warn(`[CATEGORY-ATTR-SYNC] ⚠️  Category ${categoryId} sync failed: ${response.status}`)
                                    console.warn(`[CATEGORY-ATTR-SYNC] Response: ${errorText}`)
                                }
                            } catch (error: any) {
                                console.error(`[CATEGORY-ATTR-SYNC] ❌ Category ${categoryId} error:`, error.message)
                            }
                        }

                    } catch (error: any) {
                        console.error("[CATEGORY-ATTR-SYNC] ❌ Middleware error during sync process:", error.message)
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

/**
 * AUTO-SYNC CATEGORY SORTING MIDDLEWARE
 * 
 * Automatically cleans up sorting_config metadata when:
 * - Products are deleted
 * - Products are removed from categories
 * - Categories are deleted
 * - Categories are moved (parent changed)
 * 
 * Pattern: Same as Filters sync (HTTP-based, non-blocking)
 */
async function syncCategorySortingMiddleware(
    req: MedusaRequest,
    res: MedusaResponse,
    next: MedusaNextFunction
) {
    const method = req.method?.toUpperCase()
    if (method !== 'POST' && method !== 'PUT' && method !== 'DELETE') {
        return next()
    }

    const originalJson = res.json.bind(res)

    res.json = (data: any) => {
        // Detect product or category changes
        const hasProduct = data?.product
        const hasProducts = data?.products && Array.isArray(data.products)
        const hasCategory = data?.product_category
        const isProductDelete = method === 'DELETE' && req.path?.includes('/products/')
        const isCategoryDelete = method === 'DELETE' && req.path?.includes('/product-categories/')

        if (hasProduct || hasProducts || hasCategory || isProductDelete || isCategoryDelete) {
            setImmediate(async () => {
                try {
                    const query = (req as any).scope.resolve("query")
                    const affectedCategories = new Set<string>()

                    // Handle product deletion
                    if (isProductDelete) {
                        const productId = req.params.id
                        console.log(`[SORTING-SYNC] 🗑️  Product deleted: ${productId}`)

                        // Find all categories that might have this product in sorting_config
                        const { data: allCategories } = await query.graph({
                            entity: "product_category",
                            fields: ["id", "metadata"],
                            filters: {}
                        })

                        allCategories?.forEach((cat: any) => {
                            const productOrder = cat.metadata?.sorting_config?.product_order || []
                            if (productOrder.includes(productId)) {
                                affectedCategories.add(cat.id)
                            }
                        })
                    }

                    // Handle category deletion
                    else if (isCategoryDelete) {
                        const categoryId = req.params.id
                        console.log(`[SORTING-SYNC] 🗑️  Category deleted: ${categoryId}`)

                        // Find parent category to clean it
                        const { data: deletedCategory } = await query.graph({
                            entity: "product_category",
                            fields: ["parent_category_id"],
                            filters: { id: categoryId }
                        })

                        if (deletedCategory?.[0]?.parent_category_id) {
                            affectedCategories.add(deletedCategory[0].parent_category_id)
                        }
                    }

                    // Handle product updates (category assignment changes)
                    else if (hasProduct || hasProducts) {
                        const products = hasProducts ? data.products : [data.product]
                        const productIds = products.map((p: any) => p.id)

                        const { data: productsWithCategories } = await query.graph({
                            entity: "product",
                            fields: ["id", "categories.id"],
                            filters: { id: productIds }
                        })

                        productsWithCategories?.forEach((product: any) => {
                            product.categories?.forEach((cat: any) => {
                                if (cat?.id) affectedCategories.add(cat.id)
                            })
                        })
                    }

                    // Handle category updates (parent changes)
                    else if (hasCategory) {
                        const category = data.product_category

                        // Check if parent changed
                        const { data: oldCategory } = await query.graph({
                            entity: "product_category",
                            fields: ["id", "parent_category_id"],
                            filters: { id: category.id }
                        })

                        // Sync both old and new parents
                        if (oldCategory?.[0]?.parent_category_id) {
                            affectedCategories.add(oldCategory[0].parent_category_id)
                        }
                        if (category.parent_category_id) {
                            affectedCategories.add(category.parent_category_id)
                        }
                    }

                    if (affectedCategories.size === 0) {
                        return
                    }

                    console.log(`[SORTING-SYNC] 🎯 Found ${affectedCategories.size} categories to sync`)

                    const syncBasePath = `http://localhost:${process.env.PORT || 9000}`

                    for (const categoryId of affectedCategories) {
                        try {
                            const response = await fetch(`${syncBasePath}/admin/product-categories/${categoryId}/sync-sorting`, {
                                method: "POST",
                                headers: {
                                    "Content-Type": "application/json",
                                    "Cookie": req.headers.cookie || "",
                                    "Authorization": req.headers.authorization || ""
                                }
                            })

                            if (response.ok) {
                                const result = await response.json()
                                if (result.cleaned) {
                                    console.log(`[SORTING-SYNC] ✅ Category ${categoryId}: Removed ${result.removed.subcategories + result.removed.products} orphaned IDs`)
                                }
                            } else {
                                console.warn(`[SORTING-SYNC] ⚠️  Category ${categoryId} sync failed: ${response.status}`)
                            }
                        } catch (error: any) {
                            console.error(`[SORTING-SYNC] ❌ Category ${categoryId} error:`, error.message)
                        }
                    }

                } catch (error: any) {
                    console.error("[SORTING-SYNC] ❌ Middleware error:", error.message)
                }
            })
        }

        return originalJson(data)
    }

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
        {
            // ⭐ SORTING SYNC: Products (deletions, category changes)
            matcher: "/admin/products*",
            middlewares: [syncCategorySortingMiddleware],
        },
        {
            // ⭐ SORTING SYNC: Categories (deletions, parent changes)
            matcher: "/admin/product-categories*",
            middlewares: [syncCategorySortingMiddleware],
        },
    ],
})

