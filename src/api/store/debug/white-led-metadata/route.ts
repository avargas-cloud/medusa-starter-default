// @ts-nocheck - suppress type errors in debug endpoint
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

/**
 * GET /store/debug/white-led-metadata (PUBLIC - NO AUTH)
 * 
 * Temporary public endpoint to retrieve metadata
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    const query = req.scope.resolve("query")

    try {
        // Find White LED strips category
        const { data: categories } = await query.graph({
            entity: "product_category",
            fields: ["id", "name", "metadata"],
            filters: { name: "WHITE LED STRIPS" }
        })

        if (!categories || categories.length === 0) {
            return res.status(404).json({ error: "Category not found" })
        }

        const category = categories[0]

        return res.json({
            category_id: category.id,
            category_name: category.name,
            metadata: category.metadata,
            stats: {
                available_attributes_count: category.metadata?.available_attributes?.length || 0,
                filters_count: category.metadata?.filters?.length || 0,
                filters_metadata_total_products: category.metadata?.filters_metadata?.total_products || null
            }
        })

    } catch (error: any) {
        return res.status(500).json({
            error: (error as Error).message,
            stack: error.stack
        })
    }
}
