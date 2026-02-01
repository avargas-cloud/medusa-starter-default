// @ts-nocheck - suppress type errors in admin tool
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { generateFiltersForCategory } from "../[id]/generate-filters/generator"

/**
 * ☢️ NUCLEAR FILTER SYNC ☢️
 * 
 * TRUE Nuclear Option:
 * 1. Auto-discover available_filters for ALL categories
 * 2. Auto-activate all discovered filters
 * 3. Generate filter counts for all
 * 
 * This processes ALL 126 categories from scratch
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const query = req.scope.resolve("query")
    const knex = req.scope.resolve("__pg_connection__")

    try {
        console.log('[NUCLEAR-SYNC] ☢️  Starting TRUE nuclear filter sync...')
        console.log('[NUCLEAR-SYNC] ⚠️  This will process ALL categories')

        const startTime = Date.now()

        // 1. Get ALL categories
        const { data: allCategories } = await query.graph({
            entity: "product_category",
            fields: ["id", "handle", "name", "metadata"],
            filters: {}
        })

        console.log(`[NUCLEAR-SYNC] 📦 Found ${allCategories.length} total categories`)

        // Helper: Get descendants
        function getDescendants(categoryId: string): string[] {
            const descendants: string[] = []
            for (const cat of allCategories) {
                if (cat.parent_category_id === categoryId) {
                    descendants.push(cat.id)
                    descendants.push(...getDescendants(cat.id))
                }
            }
            return descendants
        }

        let phase1Success = 0
        let phase1Skipped = 0
        let phase2Success = 0
        let phase2Failed = 0

        // PHASE 1: Auto-discover and configure filters for ALL categories
        console.log(`\n[NUCLEAR-SYNC] 🔬 PHASE 1: Auto-discover filters...`)

        for (const category of allCategories) {
            // Parse metadata safely
            let metadata: any = {}
            try {
                metadata = typeof category.metadata === 'string'
                    ? JSON.parse(category.metadata)
                    : (category.metadata || {})
            } catch (e) {
                metadata = {}
            }

            // Read include_descendants_tree (default true)
            const includeDescendants = metadata?.include_descendants_tree ?? true

            // Build category list
            const categoryIdsToScan = includeDescendants
                ? [category.id, ...getDescendants(category.id)]
                : [category.id]

            // Get products in these categories
            const { data: products } = await query.graph({
                entity: "product",
                fields: ["id"],
                filters: {
                    status: "published",
                    categories: {
                        id: categoryIdsToScan
                    }
                }
            })

            if (!products || products.length === 0) {
                phase1Skipped++
                continue
            }

            const productIds = products.map((p: any) => p.id)

            // Get attributes from these products
            const { data: attributeValues } = await query.graph({
                entity: "attribute_value",
                fields: ["attribute_key_id"],
                filters: {
                    product_link: {
                        product_id: productIds
                    }
                }
            })

            const uniqueAttrIds = [...new Set(attributeValues.map((av: any) => av.attribute_key_id))]

            if (uniqueAttrIds.length === 0) {
                phase1Skipped++
                continue
            }

            // Build filter_config
            const availableFilters = uniqueAttrIds.map((attrId, index) => ({
                attribute_id: attrId,
                order: index,
                type: 'checkbox'
            }))

            const activeFilters = availableFilters.map(f => f.attribute_id) // Activate ALL

            const newMetadata = {
                ...metadata,
                filter_config: {
                    override_inheritance: metadata?.filter_config?.override_inheritance ?? false,
                    available_filters: availableFilters,
                    active_filters: activeFilters  // ⭐ AUTO-ACTIVATE ALL
                }
            }

            // Update category
            await knex("product_category")
                .where("id", category.id)
                .update({
                    metadata: JSON.stringify(newMetadata),
                    updated_at: new Date()
                })

            phase1Success++

            if (phase1Success % 10 === 0) {
                console.log(`[NUCLEAR-SYNC]    Progress: ${phase1Success} categories configured...`)
            }
        }

        console.log(`[NUCLEAR-SYNC] ✅ PHASE 1 Complete: ${phase1Success} configured, ${phase1Skipped} skipped (no products)`)

        // PHASE 2: Generate filter counts for all configured categories
        console.log(`\n[NUCLEAR-SYNC] 📊 PHASE 2: Generate filter counts...`)

        // Re-fetch categories to get updated filter_config
        const { data: updatedCategories } = await query.graph({
            entity: "product_category",
            fields: ["id", "handle", "name", "metadata"],
            filters: {}
        })

        const categoriesWithFilters = updatedCategories.filter((cat: any) => {
            let metadata: any = {}
            try {
                metadata = typeof cat.metadata === 'string'
                    ? JSON.parse(cat.metadata)
                    : (cat.metadata || {})
            } catch (e) {
                metadata = {}
            }
            return metadata?.filter_config?.active_filters?.length > 0
        })

        console.log(`[NUCLEAR-SYNC] 📦 Generating counts for ${categoriesWithFilters.length} categories...`)

        for (const category of categoriesWithFilters) {
            try {
                // Parse metadata
                let metadata: any = {}
                try {
                    metadata = typeof category.metadata === 'string'
                        ? JSON.parse(category.metadata)
                        : (category.metadata || {})
                } catch (e) {
                    metadata = {}
                }

                const filterConfig = metadata.filter_config
                const activeFilterIds = filterConfig.active_filters

                // Read setting
                const includeDescendants = metadata?.include_descendants_tree ?? true

                // Generate filters
                const result = await generateFiltersForCategory(
                    category.id,
                    activeFilterIds,
                    query,
                    knex,
                    includeDescendants
                )

                // Update metadata with filters
                await knex("product_category")
                    .where("id", category.id)
                    .update({
                        metadata: knex.raw("jsonb_set(metadata, '{filters}', ?)", [
                            JSON.stringify(result.filters)
                        ]),
                        updated_at: new Date()
                    })

                phase2Success++

                if (phase2Success % 10 === 0) {
                    console.log(`[NUCLEAR-SYNC]    Progress: ${phase2Success} filters generated...`)
                }

            } catch (error: any) {
                console.error(`[NUCLEAR-SYNC]    ❌ Error for ${category.name}:`, error.message)
                phase2Failed++
            }
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(1)

        console.log(`\n[NUCLEAR-SYNC] ✅ PHASE 2 Complete: ${phase2Success} generated, ${phase2Failed} failed`)
        console.log(`[NUCLEAR-SYNC] 🎉 NUCLEAR SYNC COMPLETE in ${duration}s`)

        return res.json({
            success: true,
            duration_seconds: parseFloat(duration),
            phase1: {
                processed: phase1Success,
                skipped: phase1Skipped
            },
            phase2: {
                generated: phase2Success,
                failed: phase2Failed
            },
            total_categories: allCategories.length
        })

    } catch (error: any) {
        console.error('[NUCLEAR-SYNC] ❌ FATAL ERROR:', error)
        console.error('[NUCLEAR-SYNC] Stack:', error.stack)
        return res.status(500).json({
            error: "Nuclear sync failed",
            message: error.message,
            stack: error.stack
        })
    }
}
