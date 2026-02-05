import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { enrichProducts } from "../../../_shared/product-enrichment"
import { calculateFilters } from "../../../_shared/filter-calculation"

/**
 * GET /store/categories/:id/products-with-filters
 * 
 * Combined endpoint that returns:
 * - Paginated products (with prices + attributes)
 * - Dynamic filters (calculated from ALL products matching the query)
 * 
 * Respects category.metadata.include_descendants_tree setting
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    try {
        const { id } = req.params

        if (!id) {
            return res.status(400).json({ error: "id required" })
        }
        const { limit = 20, offset = 0 } = req.query

        const query = req.scope.resolve("query")
        const knex = req.scope.resolve("__pg_connection__")

        console.log(`\n[PRODUCTS-WITH-FILTERS] 📦 Fetching for category: ${id}`)
        console.log(`[PRODUCTS-WITH-FILTERS] 📄 Pagination: limit=${limit}, offset=${offset}`)

        // 1. Get category info (includes metadata)
        const { data: categories } = await query.graph({
            entity: "product_category",
            filters: { id },
            fields: ["id", "name", "handle", "parent_category_id", "metadata"]
        })

        if (!categories || categories.length === 0) {
            return res.status(404).json({ error: "Category not found" })
        }

        const category = categories[0]!  // Safe: checked 404 above
        const includeDescendants = category.metadata?.include_descendants_tree ?? true

        console.log(`[PRODUCTS-WITH-FILTERS] 🌳 include_descendants_tree: ${includeDescendants}`)

        // 2. Get descendant category IDs if needed
        let categoryIds = [id]
        if (includeDescendants) {
            const descendants = await getCategoryDescendants(id, query)
            categoryIds = [id, ...descendants]
            console.log(`[PRODUCTS-WITH-FILTERS] 👨‍👩‍👧‍👦 Including ${descendants.length} descendant categories`)
        }

        // 3. Build product query filters
        const productFilters: any = {
            status: "published",
            categories: { id: categoryIds }
        }

        // 4. Query productos PAGINADOS (for response)
        const { data: paginatedProducts } = await query.graph({
            entity: "product",
            filters: productFilters,
            fields: ["*", "variants.*"],
            pagination: { skip: parseInt(offset as string), take: parseInt(limit as string) }
        })

        // 5. Query ALL product IDs (for filters calculation + total count)
        const { data: allProducts } = await query.graph({
            entity: "product",
            fields: ["id"],
            filters: productFilters,
            pagination: { take: 10000 } // Get all
        })

        const allProductIds = allProducts.map((p: any) => p.id)
        const totalCount = allProducts.length

        console.log(`[PRODUCTS-WITH-FILTERS] 📦 Found ${totalCount} total products, returning ${paginatedProducts.length}`)

        // 6. Enrich paginated products (prices + attributes)
        const enrichedProducts = await enrichProducts(paginatedProducts, req)

        // 7. Get configured filters from category metadata
        const filterConfig = category.metadata?.filter_config as any
        let configuredFilters: any[] = []

        if (filterConfig?.active_filters && Array.isArray(filterConfig.active_filters)) {
            // Parse active_filters (can be string[] or object[])
            let activeFilterIds = typeof filterConfig.active_filters[0] === 'string'
                ? filterConfig.active_filters as string[]
                : (filterConfig.active_filters as Array<{ attribute_id: string }>).map(f => f.attribute_id)

            // ⭐ Validate against available_filters (only include filters that exist in child's products)
            if (filterConfig?.available_filters && Array.isArray(filterConfig.available_filters)) {
                const availableFilterIds = filterConfig.available_filters.map((f: any) => f.attribute_id)
                activeFilterIds = activeFilterIds.filter(id => availableFilterIds.includes(id))
                console.log(`[PRODUCTS-WITH-FILTERS] ⚖️ Validated ${activeFilterIds.length} active filters against available_filters`)
            }

            // Fetch attribute configurations (only for valid filters)
            const { data: attributes } = await query.graph({
                entity: "attribute_key",
                filters: { id: activeFilterIds },
                fields: ["id", "handle", "label", "metadata"]
            })

            configuredFilters = attributes.map((attr: any) => ({
                id: attr.id,
                attribute: attr.handle,
                name: attr.label,
                type: attr.metadata?.filter_type || "checkbox",
                options: attr.metadata?.filter_values || []
            }))
        }

        // 8. Calculate filters from ALL products
        const calculatedFilters = await calculateFilters(
            allProductIds,
            knex,
            query,
            configuredFilters
        )

        // 9. Return combined response
        return res.json({
            category: {
                id: category.id,
                name: category.name,
                handle: category.handle,
                parent_category_id: category.parent_category_id,
                include_descendants_tree: includeDescendants
            },
            products: enrichedProducts,
            filters: calculatedFilters,
            pagination: {
                total: totalCount,
                limit: parseInt(limit as string),
                offset: parseInt(offset as string),
                has_more: parseInt(offset as string) + parseInt(limit as string) < totalCount
            }
        })

    } catch (error: any) {
        console.error("[PRODUCTS-WITH-FILTERS] ❌ Error:", (error as Error).message)
        return res.status(500).json({ error: (error as Error).message })
    }
}

/**
 * Recursively get all descendant category IDs
 */
async function getCategoryDescendants(categoryId: string, query: any, depth = 0): Promise<string[]> {
    // Safety limit to prevent infinite loops
    if (depth > 5) {
        console.warn(`⚠️  Max recursion depth reached for category ${categoryId}`)
        return []
    }

    const { data: children } = await query.graph({
        entity: "product_category",
        filters: { parent_category_id: categoryId },
        fields: ["id"]
    })

    if (!children || children.length === 0) {
        return []
    }

    const descendants: string[] = []
    for (const child of children) {
        descendants.push(child.id)
        const grandchildren = await getCategoryDescendants(child.id, query, depth + 1)
        descendants.push(...grandchildren)
    }

    return descendants
}
