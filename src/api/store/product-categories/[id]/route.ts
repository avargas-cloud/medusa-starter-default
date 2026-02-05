import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

/**
 * GET /store/product-categories/:id
 *  
 * Custom endpoint that overrides the native one to add breadcrumbs automatically.
 * Returns the category with breadcrumbs field included.
 */

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    const categoryId = req.params.id
    const query = req.scope.resolve("query")

    try {
        // Get full category data using query.graph with explicit fields
        const { data: categories } = await query.graph({
            entity: "product_category",
            fields: [
                "id",
                "name",
                "handle",
                "description",
                "parent_category_id",
                "rank",
                "is_active",
                "is_internal",
                "created_at",
                "updated_at",
                "metadata"
            ],
            filters: { id: categoryId }
        })

        const category = categories?.[0]

        if (!category) {
            return res.status(404).json({
                type: "not_found",
                message: `Product category with id: ${categoryId} was not found`
            })
        }

        // Build breadcrumbs
        const breadcrumbs: Array<{ id: string; name: string; handle: string }> = []
        let currentId: string | null | undefined = categoryId
        let depth = 0
        const MAX_DEPTH = 10

        while (currentId && depth < MAX_DEPTH) {
            const { data: cats }: { data: any[] } = await query.graph({
                entity: "product_category",
                fields: ["id", "name", "handle", "parent_category_id"],
                filters: { id: currentId }
            })

            const cat: any = cats?.[0]
            if (!cat) break

            breadcrumbs.unshift({
                id: cat.id,
                name: cat.name,
                handle: cat.handle
            })

            currentId = cat.parent_category_id
            depth++
        }

        // Get category_children (subcategories) with metadata
        const { data: children } = await query.graph({
            entity: "product_category",
            fields: ["id", "name", "handle", "rank", "metadata"],
            filters: { parent_category_id: categoryId }
        })

        // Add breadcrumbs and children to response
        const categoryWithBreadcrumbs = {
            ...category,
            breadcrumbs,
            category_children: children || []
        }

        return res.json({
            product_category: categoryWithBreadcrumbs
        })

    } catch (error: any) {
        return res.status(500).json({
            type: "internal_error",
            message: error.message || "Failed to retrieve category"
        })
    }
}

// Public endpoint
export const AUTHENTICATE = false
