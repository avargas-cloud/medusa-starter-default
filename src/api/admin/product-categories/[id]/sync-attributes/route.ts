import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

/**
 * SYNC ATTRIBUTES ENDPOINT V2
 * 
 * Auto-called by middleware when products are updated.
 * Reconciles available_filters for a single category using nuclear sync logic.
 * 
 * ✅ Uses Knex for direct metadata updates (per QUERY_PATTERNS_REFERENCE.md)
 * ✅ Preserves all other metadata fields (critical for metadata spread bug fix)
 * ✅ Recursive scanning of descendant categories
 */
export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
) {
    const { id: categoryId } = req.params

    if (!categoryId) {
        res.status(400).json({ error: "categoryId is required" })
        return
    }

    const query = req.scope.resolve("query")
    const knex = req.scope.resolve("__pg_connection__")

    try {
        // 1. Get category with metadata
        const { data: categories } = await query.graph({
            entity: "product_category",
            fields: ["id", "name", "metadata", "parent_category_id"],
            filters: { id: categoryId }
        })

        if (!categories || categories.length === 0) {
            return res.status(404).json({ error: "Category not found" })
        }

        const category = categories[0]!  // Safe: checked length

        // 2. Get all descendant categories (recursive scan)
        const { data: allCategories } = await query.graph({
            entity: "product_category",
            fields: ["id", "parent_category_id"],
            filters: {}
        })

        function getDescendants(catId: string): string[] {
            const descendants: string[] = []
            for (const cat of allCategories) {
                if (cat.parent_category_id === catId) {
                    descendants.push(cat.id)
                    descendants.push(...getDescendants(cat.id))
                }
            }
            return descendants
        }

        const categoryIdsToScan = [categoryId, ...getDescendants(categoryId)]

        // 3. Query attributes from products (relational table, NOT metadata)
        // ⭐ Uses KNEX for reliability (per QUERY_PATTERNS_REFERENCE.md)
        const attributesResult = await knex.raw(`
            SELECT DISTINCT av.attribute_key_id
            FROM product_product_productattributes_attribute_value ppav
            INNER JOIN attribute_value av ON ppav.attribute_value_id = av.id
            INNER JOIN product_category_product pcp ON ppav.product_id = pcp.product_id
            WHERE pcp.product_category_id = ANY(?::text[])
              AND ppav.deleted_at IS NULL
              AND av.deleted_at IS NULL
        `, [categoryIdsToScan])

        const attributeKeyIds = attributesResult.rows.map((row: any) => row.attribute_key_id)

        // console.log(`[SYNC-ATTRIBUTES] Category ${categoryId}:`)
        // console.log(`  - Scanned ${categoryIdsToScan.length} categories`)
        // console.log(`  - Found ${attributeKeyIds.length} attribute keys`)
        // console.log(`  - Attribute IDs:`, attributeKeyIds.slice(0, 5))

        // 4. Reconcile with existing filter_config
        const existingMetadata = category.metadata || {}
        const existingConfig = (existingMetadata.filter_config || {}) as {
            available_filters?: (string | { attribute_id: string; order: number; type: string })[]
            active_filters?: (string | { attribute_id: string; order: number; type: string })[]
            override_inheritance?: boolean
        }

        // console.log(`  - Existing available: ${existingConfig.available_filters?.length || 0}`)
        // console.log(`  - Existing active: ${existingConfig.active_filters?.length || 0}`)

        const existingAvailable = existingConfig.available_filters || []
        const existingActive = existingConfig.active_filters || []

        // Parse to IDs
        const existingAvailableIds = new Set(
            existingAvailable.map((f: any) => typeof f === 'string' ? f : f.attribute_id)
        )
