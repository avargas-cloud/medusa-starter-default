import { defineMiddlewares, authenticate } from "@medusajs/framework/http"
import { meiliClient, transformProduct, transformCustomer, PRODUCTS_INDEX, CUSTOMERS_INDEX } from "../lib/meili-backend"
import type { MedusaRequest, MedusaResponse, MedusaNextFunction } from "@medusajs/framework/http"

/**
 * Middleware to auto-sync products to MeiliSearch
 * Intercepts successful product operations and triggers async sync
 */
async function syncProductMiddleware(
    req: MedusaRequest,
    res: MedusaResponse,
    next: MedusaNextFunction
) {
    // Store original json method
    const originalJson = res.json.bind(res)

    // Override json method to intercept response
    res.json = (data: any) => {
        // Sync asynchronously AFTER response sent (don't block)
        if (data?.product) {
            setImmediate(async () => {
                try {
                    // CRITICAL: Fetch complete product with variants
                    // The HTTP response doesn't include variants by default
                    const productModule = (req as any).scope.resolve("product")
                    const [fullProduct] = await productModule.listProducts(
                        { id: [data.product.id] },
                        { relations: ["variants"] }
                    )

                    if (!fullProduct) {
                        console.warn(`⚠️  [MEILI-SYNC] Product ${data.product.id} not found`)
                        return
                    }

                    const index = meiliClient.index(PRODUCTS_INDEX)
                    const transformed = transformProduct(fullProduct)
                    await index.addDocuments([transformed])
                    console.log(`✅ [MEILI-SYNC] Product ${data.product.id} synced with ${fullProduct.variants?.length || 0} variants`)
                } catch (error: any) {
                    console.error(`❌ [MEILI-SYNC] Failed to sync product: ${error.message}`)
                }
            })
        }
        // Handle batch product operations
        else if (data?.products && Array.isArray(data.products)) {
            setImmediate(async () => {
                try {
                    // Fetch complete products with variants
                    const productModule = (req as any).scope.resolve("product")
                    const productIds = data.products.map((p: any) => p.id)
                    const fullProducts = await productModule.listProducts(
                        { id: productIds },
                        { relations: ["variants"] }
                    )

                    const index = meiliClient.index(PRODUCTS_INDEX)
                    const transformed = fullProducts.map(transformProduct)
                    await index.addDocuments(transformed)
                    console.log(`✅ [MEILI-SYNC] ${fullProducts.length} products synced with variants`)
                } catch (error: any) {
                    console.error(`❌ [MEILI-SYNC] Failed to sync products: ${error.message}`)
                }
            })
        }

        return originalJson(data)
    }

    next()
}

/**
 * Middleware to auto-sync customers to MeiliSearch
 */
async function syncCustomerMiddleware(
    req: MedusaRequest,
    res: MedusaResponse,
    next: MedusaNextFunction
) {
    const originalJson = res.json.bind(res)

    res.json = (data: any) => {
        if (data?.customer) {
            setImmediate(async () => {
                try {
                    const index = meiliClient.index(CUSTOMERS_INDEX)
                    const transformed = transformCustomer(data.customer)
                    await index.addDocuments([transformed])
                    console.log(`✅ [MEILI-SYNC] Customer ${data.customer.id} synced`)
                } catch (error: any) {
                    console.error(`❌ [MEILI-SYNC] Failed to sync customer: ${error.message}`)
                }
            })
        }

        return originalJson(data)
    }

    next()
}

/**
 * Middleware to auto-sync inventory items to MeiliSearch
 * Triggers full inventory sync via workflow when inventory changes
 */
async function syncInventoryMiddleware(
    req: MedusaRequest,
    res: MedusaResponse,
    next: MedusaNextFunction
) {
    const originalJson = res.json.bind(res)

    res.json = (data: any) => {
        // Inventory changes detected - trigger full sync
        if (data?.inventory_item || data?.inventory_items) {
            setImmediate(async () => {
                try {
                    const { syncInventoryWorkflow } = await import("../workflows/sync-inventory")
                    await syncInventoryWorkflow(req.scope).run({ input: {} })
                    console.log(`✅ [MEILI-SYNC] Inventory synced after update`)
                } catch (error: any) {
                    console.error(`❌ [MEILI-SYNC] Failed to sync inventory: ${error.message}`)
                }
            })
        }

        return originalJson(data)
    }

    next()
}

export default defineMiddlewares({
    routes: [
        // Auth middlewares (existing)
        {
            matcher: "/admin/attributes*",
            middlewares: [authenticate("user", ["session", "bearer", "api-key"])],
        },
        {
            matcher: "/admin/attribute-sets*",
            middlewares: [authenticate("user", ["session", "bearer", "api-key"])],
        },
        {
            matcher: "/admin/products/:id/attributes",
            middlewares: [authenticate("user", ["session", "bearer", "api-key"])],
        },
        {
            matcher: "/admin/products/:id/attributes/batch",
            middlewares: [authenticate("user", ["session", "bearer", "api-key"])],
        },

        // MeiliSearch auto-sync middlewares (NEW)
        {
            matcher: "/admin/products*",
            middlewares: [syncProductMiddleware],
        },
        {
            matcher: "/admin/customers*",
            middlewares: [syncCustomerMiddleware],
        },

        // Inventory auto-sync middleware
        {
            matcher: "/admin/inventory-items*",
            middlewares: [syncInventoryMiddleware],
        },
    ],
})
