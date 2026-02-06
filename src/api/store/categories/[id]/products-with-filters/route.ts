import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { enrichProducts } from "../../../_shared/product-enrichment"

/**
 * GET /store/categories/:id/products-with-filters
 * 
 * Combined endpoint that returns:
 * - Paginated products (with prices + attributes)
 * - Pre-calculated filters from metadata
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

        const category = categories[0]!
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

        // 4. Query all products to get accurate total count
        const { data: allProducts } = await query.graph({
            entity: "product",
            filters: productFilters,
            fields: ["id"]
        })

        const totalCount = allProducts.length

        // 5. Query paginated products
        const { data: paginatedProducts } = await query.graph({
            entity: "product",
            filters: productFilters,
            fields: ["*", "variants.*"],
            pagination: { skip: parseInt(offset as string), take: parseInt(limit as string) }
        })

        console.log(`[PRODUCTS-WITH-FILTERS] 📦 Found ${totalCount} total products, returning ${paginatedProducts.length}`)

        // 6. Enrich paginated products (prices + attributes)
        const enrichedProducts = await enrichProducts(paginatedProducts, req)

        // 7. Get pre-calculated filters from metadata
        const preCalculatedFilters = (category.metadata?.filters || []) as any[]

        console.log(`[PRODUCTS-WITH-FILTERS] 📊 Using ${preCalculatedFilters.length} pre-calculated filters`)

        // 8. Return combined response
        return res.json({
            category: {
                id: category.id,
                name: category.name,
                handle: category.handle,
                parent_category_id: category.parent_category_id,
                include_descendants_tree: includeDescendants
            },
            products: enrichedProducts,
            filters: preCalculatedFilters,
            pagination: {
                total: totalCount,
                limit: Number(limit),
                offset: Number(offset),
                has_more: (Number(offset) + enrichedProducts.length) < totalCount
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
async function getCategoryDescendants(categoryId: string, query: any): Promise<string[]> {
    const descendants: string[] = []
    const visited = new Set<string>()
    const queue = [categoryId]

    while (queue.length > 0) {
        const currentId = queue.shift()!

        if (visited.has(currentId)) continue
        visited.add(currentId)

        const { data: children } = await query.graph({
            entity: "product_category",
            filters: { parent_category_id: currentId },
            fields: ["id"]
        })

        for (const child of children) {
            descendants.push(child.id)
            queue.push(child.id)
        }
    }

    return descendants
}
