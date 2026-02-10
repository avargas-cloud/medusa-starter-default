import { defineMiddlewares, authenticate } from "@medusajs/medusa"
import type { MedusaRequest, MedusaResponse, MedusaNextFunction } from "@medusajs/framework/http"
import { addCategoryBreadcrumbs } from "./middlewares/add-category-breadcrumbs"


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
                                console.error(`[CATEGORY-ATTR-SYNC] ❌ Category ${categoryId} error:`, (error as Error).message)
                            }
                        }

                    } catch (error: any) {
                        console.error("[CATEGORY-ATTR-SYNC] ❌ Middleware error during sync process:", (error as Error).message)
                    }

                } catch (error: any) {
                    console.error("[CATEGORY-ATTR-SYNC] ❌ Middleware error:", (error as Error).message)
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
                            console.error(`[SORTING-SYNC] ❌ Category ${categoryId} error:`, (error as Error).message)
                        }
                    }

                } catch (error: any) {
                    console.error("[SORTING-SYNC] ❌ Middleware error:", (error as Error).message)
                }
            })
        }

        return originalJson(data)
    }

    next()
}

/**
 * AUTO-SYNC MEILISEARCH: PRODUCTS
 * 
 * Incrementally syncs products to MeiliSearch ONE AT A TIME when they change.
 * Follows the same proven pattern as category sync.
 * 
 * CRITICAL: This does NOT do bulk sync - it syncs individual products as they're modified.
 * This keeps the backend fast and responsive.
 */
async function syncProductsMeiliMiddleware(
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
        const hasProduct = data?.product
        const isProductDelete = method === 'DELETE' && req.path?.includes('/products/')

        if (hasProduct || isProductDelete) {
            setImmediate(async () => {
                try {
                    const syncBasePath = `http://localhost:${process.env.PORT || 9000}`

                    if (isProductDelete) {
                        // Product deleted - trigger full sync to cleanup index
                        console.log(`[MEILI-PRODUCT-SYNC] 🗑️  Product deleted, triggering full cleanup sync`)

                        await fetch(`${syncBasePath}/admin/search/products/sync`, {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                                "Cookie": req.headers.cookie || "",
                                "Authorization": req.headers.authorization || ""
                            }
                        })
                    } else if (hasProduct) {
                        // Single product created/updated - INCREMENTAL sync (fast!)
                        const productId = data.product.id
                        console.log(`[MEILI-PRODUCT-SYNC] 🔄 Product ${productId} changed, incremental update`)

                        const response = await fetch(`${syncBasePath}/admin/search/products/update`, {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                                "Cookie": req.headers.cookie || "",
                                "Authorization": req.headers.authorization || ""
                            },
                            body: JSON.stringify({ productId })
                        })

                        if (response.ok) {
                            const result = await response.json()
                            if (result.success) {
                                console.log(`[MEILI-PRODUCT-SYNC] ✅ Updated: ${result.title}`)
                            } else {
                                console.log(`[MEILI-PRODUCT-SYNC] ⚠️  Product not found or skipped`)
                            }
                        } else {
                            console.warn(`[MEILI-PRODUCT-SYNC] ⚠️  Update failed: ${response.status}`)
                        }
                    }
                } catch (error: any) {
                    console.error(`[MEILI-PRODUCT-SYNC] ❌ Error:`, (error as Error).message)
                }
            })
        }

        return originalJson(data)
    }

    next()
}

/**
 * AUTO-SYNC MEILISEARCH: CUSTOMERS
 * 
 * Incrementally syncs customers to MeiliSearch ONE AT A TIME when they change.
 * Pattern: Same as products, optimized for real-time updates.
 */
async function syncCustomersMeiliMiddleware(
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
        const hasCustomer = data?.customer
        const isCustomerDelete = method === 'DELETE' && req.path?.includes('/customers/')

        if (hasCustomer || isCustomerDelete) {
            setImmediate(async () => {
                try {
                    const syncBasePath = `http://localhost:${process.env.PORT || 9000}`

                    if (isCustomerDelete) {
                        console.log(`[MEILI-CUSTOMER-SYNC] 🗑️  Customer deleted, full cleanup sync`)

                        await fetch(`${syncBasePath}/admin/search/customers/sync`, {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                                "Cookie": req.headers.cookie || "",
                                "Authorization": req.headers.authorization || ""
                            }
                        })
                    } else if (hasCustomer) {
                        // INCREMENTAL sync (fast!)
                        const customerId = data.customer.id
                        console.log(`[MEILI-CUSTOMER-SYNC] 🔄 Customer ${customerId}, incremental update`)

                        const response = await fetch(`${syncBasePath}/admin/search/customers/update`, {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                                "Cookie": req.headers.cookie || "",
                                "Authorization": req.headers.authorization || ""
                            },
                            body: JSON.stringify({ customerId })
                        })

                        if (response.ok) {
                            const result = await response.json()
                            if (result.success) {
                                console.log(`[MEILI-CUSTOMER-SYNC] ✅ Updated: ${result.email}`)
                            } else {
                                console.log(`[MEILI-CUSTOMER-SYNC] ⚠️  Not found or skipped`)
                            }
                        } else {
                            console.warn(`[MEILI-CUSTOMER-SYNC] ⚠️  Update failed: ${response.status}`)
                        }
                    }
                } catch (error: any) {
                    console.error(`[MEILI-CUSTOMER-SYNC] ❌ Error:`, (error as Error).message)
                }
            })
        }

        return originalJson(data)
    }

    next()
}

/**
 * AUTO-SYNC MEILISEARCH: INVENTORY
 * 
 * Incrementally syncs inventory to MeiliSearch when variants or inventory levels change.
 * Note: Inventory sync triggers on variant changes (since inventory is tied to variants).
 */
async function syncInventoryMeiliMiddleware(
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
        // 🔍 DEBUG: Log ALL requests that reach this middleware
        console.log(`[MEILI-INVENTORY-SYNC] 🔍 DEBUG: ${method} ${req.path}`)
        console.log(`[MEILI-INVENTORY-SYNC] 🔍 Response keys: ${Object.keys(data || {}).join(', ')}`)

        // Inventory changes can come from:
        // 1. Variant updates (prices, SKUs)
        // 2. Inventory item updates (stock levels)
        // 3. Product updates (affects all variants)
        // 4. Batch variant updates (price changes via /variants/batch)
        const hasProduct = data?.product
        const hasVariant = data?.variant || data?.product_variant
        const hasInventoryItem = data?.inventory_item
        const hasPrice = data?.price || data?.prices
        const hasBatchUpdate = data?.updated && Array.isArray(data.updated)  // ✅ CRITICAL FIX
        const isInventoryPath = req.path?.includes('/inventory')

        // ✅ TRIGGER on any inventory-related change
        if (hasProduct || hasVariant || hasInventoryItem || hasPrice || hasBatchUpdate || isInventoryPath) {
            setImmediate(async () => {
                try {
                    const syncBasePath = `http://localhost:${process.env.PORT || 9000}`

                    // Determine what to sync
                    let variantIds: string[] = []
                    let productId: string | undefined

                    // ✅ BATCH VARIANT UPDATES (price changes use this!)
                    if (data.updated && Array.isArray(data.updated)) {
                        console.log(`[MEILI-INVENTORY-SYNC] 📦 Batch update detected: ${data.updated.length} variants`)
                        variantIds = data.updated.map((v: any) => v.id).filter(Boolean)
                        // Extract product ID from URL path (e.g., /admin/products/prod_123/variants/batch)
                        const productMatch = req.path.match(/\/admin\/products\/([^\/]+)\//)
                        if (productMatch) {
                            productId = productMatch[1]
                        }
                    }
                    // Single variant update
                    else if (hasVariant) {
                        variantIds = [data.variant?.id || data.product_variant?.id].filter(Boolean)
                    }
                    // Product update (sync all variants)
                    else if (hasProduct) {
                        productId = data.product.id
                    }
                    // Inventory item update
                    else if (hasInventoryItem && isInventoryPath) {
                        // When editing inventory directly, we need to find the variant
                        const query = req.scope.resolve("query")
                        try {
                            const { data: inventoryItems } = await query.graph({
                                entity: "inventory_item",
                                fields: ["id", "variants.id"],
                                filters: { id: data.inventory_item.id }
                            })

                            if (inventoryItems?.[0]?.variants?.[0]?.id) {
                                variantIds = [inventoryItems[0].variants[0].id]
                            }
                        } catch (err) {
                            console.warn(`[MEILI-INVENTORY-SYNC] Could not resolve variant for inventory item`)
                        }
                    }

                    // Skip if we don't have any identifier
                    if (variantIds.length === 0 && !productId) {
                        console.log(`[MEILI-INVENTORY-SYNC] ⚠️  No variant/product ID found, skipping sync`)
                        return
                    }

                    // Sync each variant individually (or entire product)
                    if (variantIds.length > 0) {
                        console.log(`[MEILI-INVENTORY-SYNC] 🔄 Syncing ${variantIds.length} variant(s)...`)

                        for (const variantId of variantIds) {
                            const response = await fetch(`${syncBasePath}/admin/search/inventory/update`, {
                                method: "POST",
                                headers: {
                                    "Content-Type": "application/json",
                                    "Cookie": req.headers.cookie || "",
                                    "Authorization": req.headers.authorization || ""
                                },
                                body: JSON.stringify({ variantId })
                            })

                            if (response.ok) {
                                const result = await response.json()
                                if (result.success) {
                                    console.log(`[MEILI-INVENTORY-SYNC] ✅ Updated ${result.itemsUpdated} items for variant ${variantId}`)
                                }
                            } else {
                                console.warn(`[MEILI-INVENTORY-SYNC] ⚠️  Update failed for variant ${variantId}: ${response.status}`)
                            }
                        }
                    } else if (productId) {
                        console.log(`[MEILI-INVENTORY-SYNC] 🔄 Syncing entire product: ${productId}`)

                        const response = await fetch(`${syncBasePath}/admin/search/inventory/update`, {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                                "Cookie": req.headers.cookie || "",
                                "Authorization": req.headers.authorization || ""
                            },
                            body: JSON.stringify({ productId })
                        })

                        if (response.ok) {
                            const result = await response.json()
                            if (result.success) {
                                console.log(`[MEILI-INVENTORY-SYNC] ✅ Updated ${result.itemsUpdated} items`)
                            }
                        } else {
                            console.warn(`[MEILI-INVENTORY-SYNC] ⚠️  Update failed: ${response.status}`)
                        }
                    }
                } catch (error: any) {
                    console.error(`[MEILI-INVENTORY-SYNC] ❌ Error:`, (error as Error).message)
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
        {
            // 🔍 MEILI SYNC: Products (auto-sync to search index)
            matcher: "/admin/products*",
            middlewares: [syncProductsMeiliMiddleware],
        },
        {
            // 🔍 MEILI SYNC: Customers (auto-sync to search index)
            matcher: "/admin/customers*",
            middlewares: [syncCustomersMeiliMiddleware],
        },
        {
            // 🔍 MEILI SYNC: Inventory (auto-sync to search index)
            // Covers both product variants and inventory-item endpoints
            matcher: "/admin/products*",
            middlewares: [syncInventoryMeiliMiddleware],
        },
        {
            // 🔍 MEILI SYNC: Inventory items direct endpoint
            matcher: "/admin/inventory-items*",
            middlewares: [syncInventoryMeiliMiddleware],
        },
        {
            // 🔍 MEILI SYNC: Price updates (when editing variant prices)
            matcher: "/admin/prices*",
            middlewares: [syncInventoryMeiliMiddleware],
        },
        {
            // 🍞 BREADCRUMBS: Auto-add to Store API category responses
            matcher: "/store/product-categories*",
            middlewares: [addCategoryBreadcrumbs],
        },
        {
            // 🔐 AUTHENTICATION: Enable customer authentication for /store/customers/me routes
            // This populates req.auth_context.actor_id with customer ID from JWT token
            matcher: "/store/customers/me*",
            middlewares: [authenticate("customer", ["session", "bearer"])],
        },
        {
            // 💰 CUSTOMER-SPECIFIC PRICING: Enable authentication for price endpoints
            // Allows both authenticated (specific price lists) and anonymous users (default pricing)
            // Used by ProductDynamicPricing component and product pages
            matcher: "/store/products/:id/prices-and-stock",
            middlewares: [
                authenticate("customer", ["session", "bearer"], {
                    allowUnauthenticated: true  // ✅ Guests can access without token
                }),
            ],
        },
        {
            // 💰 CUSTOMER-SPECIFIC PRICING: with-prices endpoint
            matcher: "/store/products/:id/with-prices",
            middlewares: [
                authenticate("customer", ["session", "bearer"], {
                    allowUnauthenticated: true  // ✅ Guests can access without token
                }),
            ],
        },
        {
            // 💰 CUSTOMER-SPECIFIC PRICING: with-prices-and-related endpoint
            matcher: "/store/products/by-handle/:handle/with-prices-and-related",
            middlewares: [
                authenticate("customer", ["session", "bearer"], {
                    allowUnauthenticated: true  // ✅ Guests can access without token
                }),
            ],
        },
    ],
})
