import type { MedusaRequest, MedusaResponse, MedusaNextFunction } from "@medusajs/framework/http"

/**
 * Middleware: Add Breadcrumbs to Category Response
 * 
 * Intercepts GET /store/product-categories/:id responses
 * and adds breadcrumbs field automatically using response interception.
 */

export async function addCategoryBreadcrumbs(
    req: MedusaRequest,
    res: MedusaResponse,
    next: MedusaNextFunction
) {
    // Only apply to GET requests for single category (not list endpoints)
    const isCategoryDetailEndpoint =
        req.method === "GET" &&
        req.path.match(/^\/store\/product-categories\/[^/?]+$/)

    if (!isCategoryDetailEndpoint) {
        return next()
    }

    // Store original send function
    const originalSend = res.send.bind(res)

    // Override send to inject breadcrumbs
    res.send = function (body: any) {
        try {
            // Parse response body
            const data = typeof body === 'string' ? JSON.parse(body) : body

            if (data?.product_category) {
                // Add breadcrumbs synchronously to avoid timing issues
                const query = req.scope.resolve("query")

                // Use setImmediate to add breadcrumbs without blocking
                buildAndAddBreadcrumbs(data.product_category, query)
                    .then(() => {
                        const updated = typeof body === 'string' ? JSON.stringify(data) : data
                        return originalSend(updated)
                    })
                    .catch((error) => {
                        console.error("[Breadcrumbs] Error:", error.message)
                        // Return original response on error
                        return originalSend(body)
                    })

                return res
            }
        } catch (error) {
            console.error("[Breadcrumbs] Failed to parse response:", error)
        }

        return originalSend(body)
    } as any

    next()
}

async function buildAndAddBreadcrumbs(category: any, query: any) {
    const breadcrumbs: Array<{ id: string; name: string; handle: string }> = []

    let currentId: string | null = category.id
    let depth = 0
    const MAX_DEPTH = 10

    // Build breadcrumb trail from child to root
    while (currentId && depth < MAX_DEPTH) {
        const { data: categories } = await query.graph({
            entity: "product_category",
            fields: ["id", "name", "handle", "parent_category_id"],
            filters: { id: currentId }
        })

        const cat = categories?.[0]
        if (!cat) break

        // Add to beginning (traversing from child to root)
        breadcrumbs.unshift({
            id: cat.id,
            name: cat.name,
            handle: cat.handle
        })

        currentId = cat.parent_category_id
        depth++
    }

    // Add breadcrumbs to category object
    category.breadcrumbs = breadcrumbs
}
