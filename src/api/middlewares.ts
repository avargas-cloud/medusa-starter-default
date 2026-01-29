import { defineMiddlewares } from "@medusajs/medusa"
import type { MedusaRequest, MedusaResponse, MedusaNextFunction } from "@medusajs/framework/http"
import { buildCategoryBreadcrumbsWorkflow } from "../workflows/build-category-breadcrumbs-workflow"

type BreadcrumbItem = {
    id: string
    name: string
    handle: string
}

/**
 * Breadcrumbs Auto-Calculation Middleware
 * 
 * Intercepts product update responses and auto-calculates breadcrumbs
 * when primary_category_id is updated.
 * 
 * Pattern: Response interception (NOT next() pattern)
 * Based on: MEDUSA_V2_SUBSCRIBER_BUG_AND_MIDDLEWARE_FIX.md
 */
async function breadcrumbsMiddleware(
    req: MedusaRequest,
    res: MedusaResponse,
    next: MedusaNextFunction
) {
    // Step 1: Save original res.json function
    const originalJson = res.json.bind(res)

    // Step 2: Wrap with breadcrumb calculation logic
    res.json = (data: any) => {
        // ⭐ DETECTION: Is there a product in the response?
        if (data?.product) {
            // ⭐ ASYNC: Don't block HTTP response
            setImmediate(async () => {
                try {
                    const productId = data.product.id
                    const metadata = data.product.metadata

                    // Only process if primary_category_id exists
                    if (!metadata?.primary_category_id) {
                        return
                    }

                    console.log(`[Breadcrumbs] Processing product ${productId}...`)

                    // ⭐ WORKFLOW: Calculate breadcrumbs
                    const { result } = await buildCategoryBreadcrumbsWorkflow((req as any).scope).run({
                        input: { categoryId: metadata.primary_category_id }
                    })

                    const breadcrumbs = result as BreadcrumbItem[]

                    // ⭐ UPDATE: Save breadcrumbs to metadata
                    const productModule = (req as any).scope.resolve("product")
                    await productModule.updateProducts(productId, {
                        metadata: {
                            ...metadata,
                            main_category_breadcrumbs: breadcrumbs
                        }
                    })

                    console.log(`✅ [Breadcrumbs] Product ${productId} updated with ${breadcrumbs.length} levels`)
                } catch (error: any) {
                    console.error(`❌ [Breadcrumbs] Failed:`, error.message)
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
            matcher: "/admin/products*",  // ⭐ WILDCARD: Covers all product endpoints
            middlewares: [breadcrumbsMiddleware],
        },
    ],
})
