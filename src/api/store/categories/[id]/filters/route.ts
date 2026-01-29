import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

/**
 * GET /store/categories/:id/filters
 * 
 * Public endpoint for frontend to retrieve filter configuration for a specific category.
 * Handles inheritance from parent categories when override_inheritance is false.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    const { id } = req.params

    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const productCategoryModuleService: any = req.scope.resolve(
            "productCategoryModuleService"
        )

        const category = await productCategoryModuleService.retrieveProductCategory(id, {
            select: ["id", "name", "handle", "metadata", "parent_category_id"],
        })

        if (!category) {
            return res.status(404).json({
                error: "Category not found",
            })
        }

        // Helper function to get filters with inheritance
        const getFiltersWithInheritance = async (categoryId: string, visited = new Set<string>()): Promise<Array<{ attribute_id: string, order: number, type?: string }>> => {
            // Prevent circular dependency
            if (visited.has(categoryId)) {
                return []
            }
            visited.add(categoryId)

            const cat = await productCategoryModuleService.retrieveProductCategory(categoryId, {
                select: ["id", "metadata", "parent_category_id"],
            })

            if (!cat) return []

            const config = cat.metadata?.filter_config

            // If override_inheritance is true, use this category's filters
            if (config?.override_inheritance) {
                const activeFilters = config.active_filters || []

                // Handle backward compatibility: old format is string[], new is object[]
                if (activeFilters.length > 0 && typeof activeFilters[0] === 'string') {
                    // Old format: convert to new format with auto-order
                    return activeFilters.map((id: string, index: number) => ({
                        attribute_id: id,
                        order: index,
                        type: 'checkbox'
                    }))
                } else {
                    // New format: use as-is
                    return activeFilters.map((filter: any) => ({
                        attribute_id: filter.attribute_id,
                        order: filter.order ?? 0,
                        type: filter.type ?? 'checkbox'
                    }))
                }
            }

            // Otherwise, check parent
            if (cat.parent_category_id) {
                return getFiltersWithInheritance(cat.parent_category_id, visited)
            }

            // No parent and no override = no filters
            return []
        }

        // Get active filters with metadata (with inheritance)
        const activeFilters = await getFiltersWithInheritance(id)

        // If we have filter IDs, fetch full attribute data with values
        let filters: Array<{
            id: string
            attribute: string
            attribute_id: string
            order: number
            type: string
            values: string[]
        }> = []
        if (activeFilters.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const attributeModuleService: any = req.scope.resolve("productAttributesService")

            // Extract just the IDs for querying
            const attributeIds = activeFilters.map(f => f.attribute_id)

            // Fetch attribute keys with their values AND new display metadata
            const attributeKeys = await attributeModuleService.listAttributeKeys(
                { id: attributeIds },
                {
                    select: [
                        "id",
                        "handle",
                        "label",
                        "display_name",
                        "description",
                        "filter_type",
                        "icon",
                        "unit"
                    ],
                    relations: ["values"]
                }
            )

            // Map to enriched filter objects
            filters = activeFilters.map(filterConfig => {
                const attributeKey = attributeKeys.find((k: any) => k.id === filterConfig.attribute_id)

                if (!attributeKey) return null

                return {
                    id: attributeKey.id,
                    name: attributeKey.handle,                                    // Handle for API
                    attribute: attributeKey.label,                                 // Label (backward compat)
                    display_name: attributeKey.display_name || attributeKey.label, // Fallback to label
                    description: attributeKey.description || null,                 // Optional
                    attribute_id: attributeKey.id,
                    order: filterConfig.order,
                    filter_type: attributeKey.filter_type || filterConfig.type || 'checkbox', // Use attribute config or fallback
                    icon: attributeKey.icon || null,                               // Optional
                    unit: attributeKey.unit || null,                               // Optional
                    type: filterConfig.type || 'checkbox',                         // Keep for backward compat
                    values: (attributeKey.values || []).map((v: any) => v.value)
                }
            }).filter((f): f is NonNullable<typeof f> => f !== null) // Remove any nulls from missing attributes

            // Sort by order
            filters.sort((a, b) => a.order - b.order)
        }

        return res.json({
            category_id: category.id,
            category_name: category.name,
            category_handle: category.handle,
            filters,
            inherited: category.metadata?.filter_config?.override_inheritance !== true,
        })
    } catch (error: any) {
        console.error("Error fetching category filters:", error)
        return res.status(500).json({
            error: "Failed to fetch category filters",
            message: error.message,
        })
    }
}
