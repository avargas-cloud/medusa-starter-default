import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { generateFiltersForCategory } from "../../../../../modules/category-filters/utils/filter-generator"

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const { id: categoryId } = req.params
    const { active_filters, override_inheritance } = req.body as {
        active_filters: string[]
        override_inheritance: boolean
    }

    try {
        const remoteQuery = req.scope.resolve("remoteQuery")
        const knex = req.scope.resolve("__pg_connection__")

        // Generate filters JSON
        const filtersData = await generateFiltersForCategory(
            categoryId,
            active_filters,
            remoteQuery,
            knex
        )

        // Get category to merge with existing metadata
        const queryService = req.scope.resolve("query")

        const result: any = await queryService.graph({
            entity: "product_category",
            fields: ["id", "metadata"],
            filters: { id: categoryId },
        })

        if (!result?.data || result.data.length === 0) {
            return res.status(404).json({ message: "Category not found" })
        }

        const category = result.data[0]

        // Update metadata with filter config AND generated filters
        const updatedMetadata = {
            ...category.metadata,
            filter_config: {
                override_inheritance,
                active_filters,
            },
            filters: filtersData.filters,
            filters_metadata: filtersData.metadata,
        }

        // Use raw Knex to update
        await knex("product_category")
            .where({ id: categoryId })
            .update({
                metadata: JSON.stringify(updatedMetadata),
                updated_at: new Date(),
            })

        res.json({
            success: true,
            category_id: categoryId,
            filters_generated: filtersData.filters.length,
            total_products: filtersData.metadata.total_products,
        })
    } catch (error: any) {
        console.error("Error generating filters:", error)
        res.status(500).json({
            success: false,
            message: "Failed to generate filters",
            error: error.message,
        })
    }
}
