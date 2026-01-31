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
        const queryService = req.scope.resolve("query")

        // Get category using query service
        const categoryResult: any = await queryService.graph({
            entity: "product_category",
            fields: ["id", "name", "handle", "metadata", "parent_category_id"],
            filters: { id },
        })

        if (!categoryResult?.data || categoryResult.data.length === 0) {
            return res.status(404).json({
                error: "Category not found",
            })
        }

        const category = categoryResult.data[0]

        // Helper function to get filters with inheritance
        const getFiltersWithInheritance = async (categoryId: string, visited = new Set<string>()): Promise<Array<{ attribute_id: string, order: number, type?: string }>> => {
            // Prevent circular dependency
            if (visited.has(categoryId)) {
                return []
            }
            visited.add(categoryId)

            const catResult: any = await queryService.graph({
                entity: "product_category",
                fields: ["id", "metadata", "parent_category_id"],
                filters: { id: categoryId },
            })

            if (!catResult?.data || catResult.data.length === 0) return []

            const cat = catResult.data[0]
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
            values: string[] | Array<{ value: string; count: number }>
        }> = []
        if (activeFilters.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const attributeModuleService: any = req.scope.resolve("productAttributes")

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
                    options: (attributeKey.values || []).map((v: any) => v.value)
                }
            }).filter((f): f is NonNullable<typeof f> => f !== null) // Remove any nulls from missing attributes

            // Sort by order
            filters.sort((a, b) => a.order - b.order)

            // ⭐ Calculate product counts for this specific category
            console.log(`🔢 Calculating product counts for category: ${id}`)

            // Get products in category
            const productsResult: any = await queryService.graph({
                entity: "product",
                fields: ["id", "title"],
                filters: {
                    // @ts-expect-error - Medusa v2 query syntax
                    categories: { id: id }
                },
            })

            const products = productsResult?.data || []
            console.log(`📦 Found ${products.length} products in category`)

            if (products.length === 0) {
                console.log(`⚠️  No products in category, returning filters with 0 counts`)
                // Return filters with zero counts
                filters = filters.map(filter => ({
                    ...filter,
                    options: (filter.options || []).map((opt: string | { option: string }) => ({
                        option: typeof opt === 'string' ? opt : opt.option,
                        count: 0
                    }))
                }))
                return res.json({ category_id: id, category_name, category_handle, filters, inherited })
            }

            // Get knex for direct SQL queries (same as admin attributes endpoint)
            const knex = req.scope.resolve("__pg_connection__")

            // Get all product IDs
            const productIds = products.map((p: any) => p.id)

            // Fetch ALL attribute links for ALL products in one query
            const allLinks = await knex("product_product_productattributes_attribute_value")
                .select("product_id", "attribute_value_id")
                .whereIn("product_id", productIds)
                .whereNull("deleted_at")

            console.log(`🔗 Found ${allLinks.length} total attribute links for ${productIds.length} products`)

            if (allLinks.length === 0) {
                console.log(`⚠️  No attributes found for products, returning filters with 0 counts`)
                filters = filters.map(filter => ({
                    ...filter,
                    options: (filter.options || []).map((opt: string | { option: string }) => ({
                        option: typeof opt === 'string' ? opt : opt.option,
                        count: 0
                    }))
                }))
                return res.json({ category_id: id, category_name, category_handle, filters, inherited })
            }

            // Get unique attribute value IDs
            const allAttributeValueIds = [...new Set(allLinks.map((l: any) => l.attribute_value_id))]

            // Fetch all attribute values with their keys
            const { data: allAttributeValues } = await queryService.graph({
                entity: "attribute_value",
                fields: [
                    "id",
                    "value",
                    "attribute_key.id",
                    "attribute_key.handle",
                    "attribute_key.label"
                ],
                filters: { id: allAttributeValueIds }
            })

            console.log(`📋 Fetched ${allAttributeValues.length} attribute values`)

            // Count products per filter value
            filters = filters.map(filter => {
                const optionCounts: Record<string, number> = {}

                // Extract original string options
                const originalOptions: string[] = Array.isArray(filter.options)
                    ? (typeof filter.options[0] === 'string'
                        ? filter.options as string[]
                        : (filter.options as Array<{ option: string }>).map((v: any) => v.option))
                    : []

                // Initialize all options with 0
                originalOptions.forEach((option: string) => {
                    optionCounts[option] = 0
                })

                console.log(`\n🔍 Processing filter: ${filter.name} (${filter.attribute})`)
                console.log(`  Possible options:`, originalOptions.slice(0, 5))

                // For each product, check if it has this attribute
                products.forEach((product: any) => {
                    // Find all attribute values for this product
                    const productLinks = allLinks.filter((l: any) => l.product_id === product.id)
                    const productAttributeValueIds = productLinks.map((l: any) => l.attribute_value_id)

                    // Find attribute values that match THIS filter's handle
                    const matchingValues = allAttributeValues.filter((av: any) =>
                        productAttributeValueIds.includes(av.id) &&
                        av.attribute_key?.handle === filter.name
                    )

                    // Count each value
                    matchingValues.forEach((av: any) => {
                        const optionValue = av.value
                        console.log(`    ✓ Product "${product.title}": ${filter.name} = "${optionValue}"`)

                        if (optionCounts.hasOwnProperty(optionValue)) {
                            optionCounts[optionValue]++
                        } else {
                            console.log(`      ⚠️ Option "${optionValue}" not in available options list`)
                        }
                    })
                })

                console.log(`  Filter "${filter.name}" counts:`, optionCounts)

                // Transform options array to include counts
                return {
                    ...filter,
                    options: originalOptions.map((option: string) => ({
                        option,
                        count: optionCounts[option] || 0
                    }))
                }
            })
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
