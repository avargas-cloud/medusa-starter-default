import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

/**
 * GET /store/categories/:id/sorting
 * 
 * Returns the sorting configuration for a category (subcategories & products order).
 * Supports inheritance from parent category if no sorting_config is set.
 * 
 * Response format:
 * {
 *   category_id: string
 *   category_name: string
 *   category_handle: string
 *   subcategories: Array<{ id, name, handle, order }>
 *   products: Array<{ id, title, handle, thumbnail?, order }>
 *   inherited: boolean
 * }
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    const { id: categoryId } = req.params
    const query = req.scope.resolve("query")

    try {
        // 1. Fetch the category with metadata
        const { data: categories } = await query.graph({
            entity: "product_category",
            fields: ["id", "name", "handle", "parent_category_id", "metadata"],
            filters: { id: categoryId }
        })

        if (!categories || categories.length === 0) {
            return res.status(404).json({
                error: "Category not found",
                category_id: categoryId
            })
        }

        const category = categories[0]
        let sortingConfig = category.metadata?.sorting_config
        let inherited = false

        // 2. Handle inheritance - traverse up to parent if no config
        if (!sortingConfig && category.parent_category_id) {
            const { data: parentCategories } = await query.graph({
                entity: "product_category",
                fields: ["id", "metadata"],
                filters: { id: category.parent_category_id }
            })

            if (parentCategories && parentCategories.length > 0) {
                const parentConfig = parentCategories[0].metadata?.sorting_config
                if (parentConfig) {
                    sortingConfig = parentConfig
                    inherited = true
                }
            }
        }

        // 3. Fetch subcategories for this category
        const { data: allSubcategories } = await query.graph({
            entity: "product_category",
            fields: ["id", "name", "handle"],
            filters: { parent_category_id: categoryId }
        })

        // 4. Fetch products for this category
        const { data: allProducts } = await query.graph({
            entity: "product",
            fields: ["id", "title", "handle", "thumbnail"],
            filters: {
                categories: { id: categoryId }
            }
        })

        // 5. Apply sorting order from config
        const subcategoryOrder = sortingConfig?.subcategory_order || []
        const productOrder = sortingConfig?.product_order || []

        // Sort subcategories based on order array
        const orderedSubcategories = subcategoryOrder
            .map((id: string, index: number) => {
                const subcat = allSubcategories?.find((s: any) => s.id === id)
                return subcat ? { ...subcat, order: index } : null
            })
            .filter(Boolean)

        // Add any subcategories not in the order array (append at end)
        const unorderedSubcats = allSubcategories?.filter(
            (s: any) => !subcategoryOrder.includes(s.id)
        ) || []

        const finalSubcategories = [
            ...orderedSubcategories,
            ...unorderedSubcats.map((s: any, idx: number) => ({
                ...s,
                order: orderedSubcategories.length + idx
            }))
        ]

        // Sort products based on order array
        const orderedProducts = productOrder
            .map((id: string, index: number) => {
                const product = allProducts?.find((p: any) => p.id === id)
                return product ? { ...product, order: index } : null
            })
            .filter(Boolean)

        // Add any products not in the order array (append at end)
        const unorderedProducts = allProducts?.filter(
            (p: any) => !productOrder.includes(p.id)
        ) || []

        const finalProducts = [
            ...orderedProducts,
            ...unorderedProducts.map((p: any, idx: number) => ({
                ...p,
                order: orderedProducts.length + idx
            }))
        ]

        return res.json({
            category_id: category.id,
            category_name: category.name,
            category_handle: category.handle,
            subcategories: finalSubcategories,
            products: finalProducts,
            inherited
        })

    } catch (error: any) {
        console.error(`[STORE-SORTING] Error fetching sorting for category ${categoryId}:`, error.message)
        return res.status(500).json({
            error: "Failed to fetch sorting configuration",
            message: error.message
        })
    }
}
