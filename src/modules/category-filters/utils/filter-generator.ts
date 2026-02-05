// Filter generator for category filters
// Uses link table product_product_productattributes_attribute_value

/**
 * Recursively fetch all descendant category IDs for a given parent category
 */
async function getAllDescendantCategoryIds(
    categoryId: string,
    remoteQuery: any
): Promise<string[]> {
    const visited = new Set<string>()
    const descendants: string[] = []

    async function traverse(parentId: string) {
        if (visited.has(parentId)) return
        visited.add(parentId)

        const children = await remoteQuery({
            entryPoint: "product_category",
            fields: ["id"],
            variables: {
                filters: { parent_category_id: parentId }
            }
        })

        for (const child of children || []) {
            descendants.push(child.id)
            await traverse(child.id)
        }
    }

    await traverse(categoryId)
    return descendants
}

// ============================================================================
// TYPES
// ============================================================================

interface AttributeKey {
    id: string
    handle: string
    label: string
    filter_type: "checkbox" | "range" | "toggle"
    icon?: string
    unit?: string
    description?: string
    metadata?: Record<string, any>
}

interface AttributeValue {
    id: string
    value: string
    attribute_key_id: string
}

interface CheckboxOption {
    value: string
    label: string
    count: number
    metadata?: Record<string, any>
}

interface RangeData {
    min: number
    max: number
    current_min: number
    current_max: number
    available_values: number[]
}

interface ToggleData {
    count_enabled: number
    count_total: number
}

interface GeneratedFilter {
    id: string
    name: string
    display_name: string
    description?: string
    filter_type: string
    filter_order: number
    icon?: string
    unit?: string
    metadata?: Record<string, any>
    options?: CheckboxOption[]
    range?: RangeData
    toggle?: ToggleData
}

// ============================================================================
// MAIN GENERATOR
// ============================================================================

export async function generateFiltersForCategory(
    categoryId: string,
    activeFilterIds: string[],
    remoteQuery: any,
    knex: any // Medusa's remote query function
): Promise<{
    filters: GeneratedFilter[]
    metadata: {
        total_filters: number
        total_products: number
        filter_logic: string
    }
}> {
    console.log(`[FILTER-GEN] Category: ${categoryId}, Active filters: ${activeFilterIds.length}`)

    // 1. Fetch attribute keys (filter definitions)
    const attributeKeys = await remoteQuery({
        entryPoint: "attribute_key",
        fields: ["id", "handle", "label", "filter_type", "icon", "unit", "description", "metadata"],
        variables: {
            filters: {
                id: activeFilterIds,
            },
        },
    })

    console.log(`[FILTER-GEN] Found ${attributeKeys?.length || 0} attribute definitions`)

    if (!attributeKeys || attributeKeys.length === 0) {
        console.log(`[FILTER-GEN] No attributes found for IDs:`, activeFilterIds)
        return {
            filters: [],
            metadata: {
                total_filters: 0,
                total_products: 0,
                filter_logic: "AND",
            },
        }
    }

    // 2. Get all descendant category IDs (recursive)
    const descendantIds = await getAllDescendantCategoryIds(categoryId, remoteQuery)
    const allCategoryIds = [categoryId, ...descendantIds]
    console.log(`[FILTER-GEN] Including ${descendantIds.length} descendant categories`)

    // 3. Fetch ALL PUBLISHED products with categories
    const allProducts = await remoteQuery({
        entryPoint: "product",
        fields: ["id", "categories.id"],
        variables: {
            filters: {
                status: ["published"]  // ⭐ ONLY PUBLISHED PRODUCTS
            }
        }
    })

    // 4. Filter client-side for THIS category OR any descendant
    const products = allProducts.filter((p: any) =>
        p.categories?.some((cat: any) => allCategoryIds.includes(cat.id))
    )

    const productIds = products?.map((p: any) => p.id) || []
    const totalProducts = productIds.length

    console.log(`[FILTER-GEN] Found ${totalProducts} published products in category ${categoryId} (including ${descendantIds.length} descendants)`)

    if (totalProducts === 0) {
        console.log(`[FILTER-GEN] No products in category, returning empty filters`)
        return {
            filters: [],
            metadata: {
                total_filters: 0,
                total_products: 0,
                filter_logic: "AND",
            },
        }
    }

    // 3. Fetch all attribute values for these attributes
    const filters: GeneratedFilter[] = []

    for (let index = 0; index < activeFilterIds.length; index++) {
        const filterId = activeFilterIds[index]
        const attribute = attributeKeys.find((attr: any) => attr.id === filterId)

        if (!attribute) {
            console.log(`[FILTER-GEN] Skipping ${filterId} - not found in attribute keys`)
            continue
        }

        const order = index + 1

        // Fallback to checkbox if filter_type is null
        const filterType = attribute.filter_type || "checkbox"
        console.log(`[FILTER-GEN] Generating filter for: ${attribute.handle} (${filterType || 'null'})`)

        // Fetch all values for this attribute key
        const attributeValues = await remoteQuery({
            entryPoint: "attribute_value",
            fields: ["id", "value", "attribute_key_id"],
            variables: {
                filters: {
                    attribute_key_id: attribute.id,
                },
            },
        })

        console.log(`[FILTER-GEN]   → Found ${attributeValues?.length || 0} total values for ${attribute.handle}`)

        if (!attributeValues || attributeValues.length === 0) {
            console.log(`[FILTER-GEN]   → No values, skipping`)
            continue
        }

        // Now generate filter based on type
        switch (filterType) {
            case "checkbox":
                const checkboxFilter = await generateCheckboxFilter(
                    attribute,
                    attributeValues,
                    productIds,
                    knex,
                    order
                )
                if (checkboxFilter.options && checkboxFilter.options.length > 0) {
                    filters.push(checkboxFilter)
                }
                break

            case "range":
                const rangeFilter = await generateRangeFilter(
                    attribute,
                    attributeValues,
                    productIds,
                    remoteQuery,
                    order
                )
                if (rangeFilter.range && rangeFilter.range.available_values.length > 0) {
                    filters.push(rangeFilter)
                }
                break

            case "toggle":
                const toggleFilter = await generateToggleFilter(
                    attribute,
                    productIds,
                    remoteQuery,
                    order
                )
                filters.push(toggleFilter)
                break
        }
    }

    console.log(`[FILTER-GEN] Generated ${filters.length} filters total`)
    filters.forEach(f => {
        if (f.options) {
            console.log(`  - ${f.name}: ${f.options.length} options`)
        } else if (f.range) {
            console.log(`  - ${f.name}: range ${f.range.min}-${f.range.max}`)
        } else if (f.toggle) {
            console.log(`  - ${f.name}: ${f.toggle.count_enabled}/${f.toggle.count_total}`)
        }
    })

    return {
        filters,
        metadata: {
            total_filters: filters.length,
            total_products: totalProducts,
            filter_logic: "AND",
        },
    }
}

// ============================================================================
// CHECKBOX FILTER GENERATOR
// ============================================================================

async function generateCheckboxFilter(
    attribute: AttributeKey,
    attributeValues: AttributeValue[],
    productIds: string[],
    knex: any,
    order: number
): Promise<GeneratedFilter> {
    console.log(`[FILTER-GEN]     → generateCheckboxFilter: ${attribute.handle}`)

    try {
        // Query the link table directly
        const valueIds = attributeValues.map(v => v.id)

        console.log(`[FILTER-GEN]       → Querying links for ${productIds.length} products x ${valueIds.length} values`)

        // Query the manual link table directly with SQL
        // ✅ CRITICAL: Filter out soft-deleted links
        const links = await knex("product_product_productattributes_attribute_value")
            .select("product_id", "attribute_value_id")
            .whereIn("product_id", productIds)
            .whereIn("attribute_value_id", valueIds)
            .whereNull("deleted_at")  // ✅ Exclude soft-deleted links

        console.log(`[FILTER-GEN]       → Found ${links?.length || 0} product-attribute links`)

        // Count occurrences of each value
        const valueCounts = new Map<string, number>()

        if (links && Array.isArray(links)) {
            links.forEach((link: any) => {
                const count = valueCounts.get(link.attribute_value_id) || 0
                valueCounts.set(link.attribute_value_id, count + 1)
            })
        }

        // Build options array
        const options: CheckboxOption[] = attributeValues
            .filter((av) => valueCounts.has(av.id))
            .map((av) => ({
                value: av.value,
                label: av.value,
                count: valueCounts.get(av.id) || 0,
            }))
            .sort((a, b) => a.label.localeCompare(b.label))

        console.log(`[FILTER-GEN]       → Generated ${options.length} checkbox options with counts`)

        return {
            id: attribute.id,
            name: attribute.handle,
            display_name: attribute.label,
            description: attribute.description,
            filter_type: "checkbox",
            filter_order: order,
            icon: attribute.icon,
            unit: attribute.unit,
            metadata: attribute.metadata,
            options,
        }
    } catch (error: any) {
        console.error(`[FILTER-GEN]     ✗ Error in generateCheckboxFilter:`, error.message)
        console.error(`[FILTER-GEN]     ✗ Stack:`, error.stack)
        return {
            id: attribute.id,
            name: attribute.handle,
            display_name: attribute.label,
            description: attribute.description,
            filter_type: "checkbox",
            filter_order: order,
            icon: attribute.icon,
            unit: attribute.unit,
            metadata: attribute.metadata,
            options: [],
        }
    }
}

// ============================================================================
// RANGE FILTER GENERATOR
// ============================================================================

async function generateRangeFilter(
    attribute: AttributeKey,
    attributeValues: AttributeValue[],
    _productIds: string[],
    _remoteQuery: any,
    order: number
): Promise<GeneratedFilter> {
    // Parse numeric values
    const numericValues: number[] = []

    attributeValues.forEach((av) => {
        const numValue = Number(av.value)
        if (!isNaN(numValue)) {
            numericValues.push(numValue)
        }
    })

    if (numericValues.length === 0) {
        return {
            id: attribute.id,
            name: attribute.handle,
            display_name: attribute.label,
            description: attribute.description,
            filter_type: "range",
            filter_order: order,
            icon: attribute.icon,
            unit: attribute.unit,
            metadata: attribute.metadata,
            range: {
                min: 0,
                max: 0,
                current_min: 0,
                current_max: 0,
                available_values: [],
            },
        }
    }

    const min = Math.min(...numericValues)
    const max = Math.max(...numericValues)
    const uniqueValues = Array.from(new Set(numericValues)).sort((a, b) => a - b)

    return {
        id: attribute.id,
        name: attribute.handle,
        display_name: attribute.label,
        description: attribute.description,
        filter_type: "range",
        filter_order: order,
        icon: attribute.icon,
        unit: attribute.unit,
        metadata: attribute.metadata,
        range: {
            min,
            max,
            current_min: min,
            current_max: max,
            available_values: uniqueValues,
        },
    }
}

// ============================================================================
// TOGGLE FILTER GENERATOR
// ============================================================================

async function generateToggleFilter(
    attribute: AttributeKey,
    productIds: string[],
    _remoteQuery: any,
    order: number
): Promise<GeneratedFilter> {
    // For toggle, we just count how many products have this attribute at all
    const remoteLink = _remoteQuery.getRemoteLink("productProductattributes")

    // Get all values for this attribute key
    const attributeValues = await _remoteQuery({
        entryPoint: "attribute_value",
        fields: ["id"],
        variables: {
            filters: {
                attribute_key_id: attribute.id,
            },
        },
    })

    const valueIds = attributeValues?.map((v: any) => v.id) || []

    const links = await remoteLink.list({
        product_id: productIds,
        attribute_value_id: valueIds,
    })

    // Count unique products with this attribute
    const productsWithAttribute = new Set(links.map((link: any) => link.product_id))
    const countEnabled = productsWithAttribute.size
    const countTotal = productIds.length

    return {
        id: attribute.id,
        name: attribute.handle,
        display_name: attribute.label,
        description: attribute.description,
        filter_type: "toggle",
        filter_order: order,
        icon: attribute.icon,
        metadata: attribute.metadata,
        toggle: {
            count_enabled: countEnabled,
            count_total: countTotal,
        },
    }
}
