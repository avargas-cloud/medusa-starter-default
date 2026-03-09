import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

/**
 * GET /store/product-categories
 * 
 * Custom list endpoint that adds breadcrumbs to each category.
 * Handles filtering by handle, name, etc.
 */

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    const query = req.scope.resolve("query")

    try {
        // Build filters from query params
        const filters: any = {}
        if (req.query.handle) filters.handle = req.query.handle
        if (req.query.name) filters.name = req.query.name

        // parent_category_id: Medusa core passes null as literal "null" string from URL
        const rawParentId = req.query.parent_category_id
        if (rawParentId !== undefined) {
            filters.parent_category_id = rawParentId === 'null' ? null : rawParentId
        }


        // Get categories using query.graph with explicit fields
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
            filters
        })

        if (!categories || categories.length === 0) {
            return res.json({
                product_categories: [],
                count: 0,
                offset: 0,
                limit: 50
            })
        }

        // Add breadcrumbs and category_children to each category
        const categoriesWithBreadcrumbs = await Promise.all(
            categories.map(async (category) => {
                // Build breadcrumbs
                const breadcrumbs = await buildBreadcrumbs(category.id, query)

                // Get category_children (subcategories) with metadata
                const childrenFilters: any = { parent_category_id: category.id }

                const { data: children } = await query.graph({
                    entity: "product_category",
                    fields: ["id", "name", "handle", "rank", "metadata"],
                    filters: childrenFilters
                })

                return {
                    ...category,
                    breadcrumbs,
                    category_children: children || []
                }
            })
        )

        // Return in Medusa format
        return res.json({
            product_categories: categoriesWithBreadcrumbs,
            count: categoriesWithBreadcrumbs.length,
            offset: Number(req.query.offset) || 0,
            limit: Number(req.query.limit) || 50
        })

    } catch (error: any) {
        return res.status(500).json({
            type: "internal_error",
            message: (error as Error).message || "Failed to retrieve categories"
        })
    }
}

async function buildBreadcrumbs(categoryId: string, query: any) {
    const breadcrumbs: Array<{ id: string; name: string; handle: string }> = []
    let currentId: string | null | undefined = categoryId
    let depth = 0
    const MAX_DEPTH = 10

    while (currentId && depth < MAX_DEPTH) {
        const { data: categories }: { data: any[] } = await query.graph({
            entity: "product_category",
            fields: ["id", "name", "handle", "parent_category_id"],
            filters: { id: currentId }
        })

        const cat: any = categories?.[0]
        if (!cat) break

        breadcrumbs.unshift({
            id: cat.id,
            name: cat.name,
            handle: cat.handle
        })

        currentId = cat.parent_category_id
        depth++
    }

    return breadcrumbs
}

// Public endpoint
export const AUTHENTICATE = false
