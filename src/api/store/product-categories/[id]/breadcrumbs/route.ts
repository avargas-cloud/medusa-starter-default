import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

/**
 * GET /store/product-categories/:id/breadcrumbs
 * 
 * Returns the breadcrumb trail for a given category.
 * 
 * Response:
 * {
 *   breadcrumbs: [
 *     { id: "pcat_01", name: "By Categories", handle: "by-categories" },
 *     { id: "pcat_02", name: "LED Drivers", handle: "led-drivers" },
 *     { id: "pcat_03", name: "Dimmable", handle: "dimmable-power-supplies" }
 *   ]
 * }
 */

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    const query = req.scope.resolve("query")
    const categoryId = req.params.id

    if (!categoryId) {
        return res.status(400).json({
            error: "Category ID is required"
        })
    }

    try {
        const breadcrumbs: Array<{ id: string; name: string; handle: string }> = []
        let currentId: string | null = categoryId
        let depth = 0
        const MAX_DEPTH = 10

        // Traverse from child to root
        while (currentId && depth < MAX_DEPTH) {
            const { data: categories } = await query.graph({
                entity: "product_category",
                fields: ["id", "name", "handle", "parent_category_id"],
                filters: { id: currentId }
            })

            const category = categories?.[0]

            if (!category) {
                return res.status(404).json({
                    error: `Category not found: ${currentId}`
                })
            }

            // Add to beginning (we're going from child → root)
            breadcrumbs.unshift({
                id: category.id,
                name: category.name,
                handle: category.handle
            })

            currentId = category.parent_category_id
            depth++
        }

        if (depth === MAX_DEPTH) {
            return res.status(500).json({
                error: "Maximum depth reached - possible circular reference"
            })
        }

        return res.json({ breadcrumbs })

    } catch (error: any) {
        return res.status(500).json({
            error: error.message || "Failed to generate breadcrumbs"
        })
    }
}

// Public endpoint - no authentication required
export const AUTHENTICATE = false
