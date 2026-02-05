import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

/**
 * SYNC SORTING ENDPOINT V2
 * 
 * Auto-called by middleware when products/categories are updated or deleted.
 * Cleans orphaned product/subcategory IDs from sorting_config metadata.
 * 
 * ✅ Uses Knex for direct metadata updates (per QUERY_PATTERNS_REFERENCE.md)
 * ✅ Avoids HTTP fetch that caused metadata spread bug
 * ✅ Preserves all other metadata fields
 */
export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
) {
    const { id: categoryId } = req.params
    const query = req.scope.resolve("query")
    const knex = req.scope.resolve("__pg_connection__")

    try {
        // 1. Get category with metadata
        const { data: categories } = await query.graph({
            entity: "product_category",
            fields: ["id", "name", "metadata"],
            filters: { id: categoryId }
        })

        if (!categories || categories.length === 0) {
            return res.status(404).json({ error: "Category not found" })
        }

        const category = categories[0]!  // Safe: checked length
        const sortingConfig = category.metadata?.sorting_config as {
            subcategory_order?: string[]
            product_order?: string[]
        } | undefined

        if (!sortingConfig) {
            // No sorting config, nothing to clean
            return res.json({
                success: true,
                cleaned: false,
                category: category.name
            })
        }

        // 2. Fetch all current subcategories
        const { data: actualSubcategories } = await query.graph({
            entity: "product_category",
            fields: ["id"],
            filters: { parent_category_id: categoryId }
        })

        const actualSubcategoryIds = new Set(
            (actualSubcategories || []).map((s: any) => s.id)
        )

        // 3. Fetch all current products in this category
        const { data: actualProducts } = await query.graph({
            entity: "product",
            fields: ["id"],
            filters: {
                categories: { id: categoryId }
            } as any  // Type is correct but overly strict
        })

        const actualProductIds = new Set(
            (actualProducts || []).map((p: any) => p.id)
        )

        // 4. Clean subcategory_order array
        const currentSubcategoryOrder = sortingConfig?.subcategory_order || []
        const cleanedSubcategoryOrder = currentSubcategoryOrder.filter(
            (id: string) => actualSubcategoryIds.has(id)
        )

        // 5. Clean product_order array
        const currentProductOrder = sortingConfig?.product_order || []
        const cleanedProductOrder = currentProductOrder.filter(
            (id: string) => actualProductIds.has(id)
        )

        // 6. Calculate what was removed
        const removedSubcategories = currentSubcategoryOrder.length - cleanedSubcategoryOrder.length
        const removedProducts = currentProductOrder.length - cleanedProductOrder.length

        // 7. Only update if something changed
        if (removedSubcategories === 0 && removedProducts === 0) {
            return res.json({
                success: true,
                cleaned: false,
                category: category.name,
                stats: {
                    subcategories: cleanedSubcategoryOrder.length,
                    products: cleanedProductOrder.length
                }
            })
        }

        // 8. ✅ Update using KNEX (per QUERY_PATTERNS_REFERENCE.md)
        // PRESERVE all other metadata fields (avoids metadata spread bug)
        const existingSortingConfig = category.metadata?.sorting_config || {}
        const newMetadata = {
            ...category.metadata,
            sorting_config: {
                ...existingSortingConfig,  // CRITICAL: Preserve prerender and other fields
                subcategory_order: cleanedSubcategoryOrder,
                product_order: cleanedProductOrder
            }
        }

        await knex("product_category")
            .where({ id: categoryId })
            .update({
                metadata: JSON.stringify(newMetadata),
                updated_at: new Date()
            })

        res.json({
            success: true,
            cleaned: true,
            category: category.name,
            removed: {
                subcategories: removedSubcategories,
                products: removedProducts
            },
            remaining: {
                subcategories: cleanedSubcategoryOrder.length,
                products: cleanedProductOrder.length
            }
        })
        return

    } catch (error: any) {
        console.error("[SYNC-SORTING] Error:", error)
        res.status(500).json({
            error: "Failed to sync sorting",
            message: (error as Error).message
        })
        return
    }
}
