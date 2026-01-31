// @ts-nocheck - suppress type errors in admin tool
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { generateFiltersForCategory } from "./generator"

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const { id: categoryId } = req.params
    const { active_filters, override_inheritance } = req.body as {
        active_filters: (string | { attribute_id: string; order?: number; type?: string })[]
        override_inheritance: boolean
    }

    try {
        const remoteQuery = req.scope.resolve("remoteQuery")
        const knex = req.scope.resolve("__pg_connection__")

        // ⭐ Normalize active_filters to string[] for generator
        const normalizedFilters = active_filters.map(f =>
            typeof f === 'string' ? f : f.attribute_id
        )

        // Generate filters JSON
        const filtersData = await generateFiltersForCategory(
            categoryId,
            normalizedFilters,
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

        console.log(`🔍 [SAVE ${categoryId}] Category fetched:`, {
            has_metadata: !!category.metadata,
            has_filter_config: !!category.metadata?.filter_config,
            available_count: category.metadata?.filter_config?.available_filters?.length || 0
        })

        // ⚡ Clean existing metadata to remove admin-only and legacy fields
        // ⭐ CRITICAL: Also exclude filter_config to prevent spread conflicts
        const {
            available_attributes,  // Remove: Auto-sync IDs (old system)
            filters_metadata,      // Remove: Total counts (old system)
            original_wc_url,       // Remove: WooCommerce URL (unused)
            filter_config: _removedFilterConfig,  // ⭐ Remove: Will rebuild below
            ...cleanExistingMetadata
        } = category.metadata || {}

        // ⭐ Get or generate available_filters from THE ORIGINAL metadata
        const existingConfig = category.metadata?.filter_config || {}
        let availableFilters = existingConfig.available_filters

        console.log(`🔍 [SAVE ${categoryId}] Existing config:`, {
            is_null: availableFilters === null,
            is_undefined: availableFilters === undefined,
            is_array: Array.isArray(availableFilters),
            length: availableFilters?.length || 0
        })

        // If null/empty, generate from category products (mini nuclear sync)
        if (!availableFilters || availableFilters.length === 0) {
            console.log(`⚡ Generating available_filters for ${categoryId} (not set by nuclear sync)`)

            // Get unique attribute IDs from category products
            const attributeQuery: any = await remoteQuery.graph({
                entity: "attribute_value",
                fields: ["attribute_key_id"],
                filters: {
                    product_link: {
                        product: {
                            categories: {
                                id: categoryId
                            }
                        }
                    }
                }
            })

            const uniqueAttrIds = [...new Set(attributeQuery.data.map((av: any) => av.attribute_key_id))]

            availableFilters = uniqueAttrIds.map((attrId, index) => ({
                attribute_id: attrId,
                order: index,
                type: 'checkbox'
            }))

            console.log(`  ✅ Generated ${availableFilters.length} available_filters`)
        } else {
            console.log(`  ✅ Preserving ${availableFilters.length} existing available_filters`)
        }

        // Update metadata with filter config AND generated filters ONLY
        const updatedMetadata = {
            ...cleanExistingMetadata,
            filter_config: {
                override_inheritance,
                available_filters: availableFilters,  // ⭐ Generated or preserved
                active_filters,  // User's manual selection
            },
            filters: filtersData.filters,
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
