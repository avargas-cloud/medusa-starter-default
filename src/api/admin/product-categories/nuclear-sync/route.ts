// @ts-nocheck - suppress type errors in admin tool
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

/**
 * Nuclear Filter Sync Endpoint
 * 
 * Regenerates filter_config for ALL categories by:
 * 1. Scanning products recursively (category + children)
 * 2. Extracting unique attribute_key_ids
 * 3. Creating filter_config with all attributes as active
 * 4. Calling /generate-filters to build 'filters' metadata
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const query = req.scope.resolve("query")

    try {
        console.log('[NUCLEAR-SYNC] 🚀 Starting nuclear filter sync...')

        // 1. Get all categories
        const { data: allCategories } = await query.graph({
            entity: "product_category",
            fields: ["id", "name", "parent_category_id", "metadata"],
            filters: {}
        })

        // 2. Helper to get descendants recursively
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

        let processedCount = 0
        let skippedCount = 0

        // 3. For each category, find attributes
        for (const category of allCategories) {
            const categoryIdsToScan = [category.id, ...getDescendants(category.id)]

            // Query unique attribute_key_ids from relational table
            const { data: attributeValues } = await query.graph({
                entity: "attribute_value",
                fields: ["attribute_key_id"],
                filters: {
                    productLinks: {
                        product: {
                            categories: {
                                id: categoryIdsToScan
                            }
                        }
                    }
                }
            })

            const attributeKeyIds = [...new Set(attributeValues.map((av: any) => av.attribute_key_id))]

            if (attributeKeyIds.length === 0) {
                skippedCount++
                continue
            }

            // ⭐ Update category metadata with filter_config
            // Match CLI script: populate available_filters, leave active_filters empty
            const existingConfig = category.metadata?.filter_config || {}
            const existingActive = existingConfig.active_filters || []

            const newMetadata = {
                ...category.metadata,
                filter_config: {
                    override_inheritance: existingConfig.override_inheritance ?? false,
                    available_filters: attributeKeyIds.map((attrId, index) => ({
                        attribute_id: attrId,
                        order: index,
                        type: 'checkbox'
                    })),
                    active_filters: existingActive // Preserve user's manual selections
                }
            }

            await query.graph({
                entity: "product_category",
                data: {
                    id: category.id,
                    metadata: newMetadata
                },
                action: "update"
            })

            processedCount++
        }

        console.log(`[NUCLEAR-SYNC] ✅ Phase 1 complete: ${processedCount} categories`)

        // 4. Call /generate-filters for each category with filter_config
        const basePath = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000"
        let generatedCount = 0
        let failedCount = 0

        for (const category of allCategories) {
            // Re-fetch category to get updated filter_config
            const { data: updatedCategories } = await query.graph({
                entity: "product_category",
                fields: ["id", "name", "metadata"],
                filters: { id: category.id }
            })

            const updatedCategory = updatedCategories[0]
            const filterConfig = (updatedCategory?.metadata?.filter_config || {}) as {
                active_filters?: any[]
                available_filters?: any[]
                override_inheritance?: boolean
            }

            if (!filterConfig?.active_filters || filterConfig.active_filters.length === 0) {
                continue
            }

            try {
                const response = await fetch(`${basePath}/admin/product-categories/${category.id}/generate-filters`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Cookie": req.headers.cookie || "",
                        "Authorization": req.headers.authorization || ""
                    },
                    body: JSON.stringify({
                        active_filters: filterConfig.active_filters,
                        override_inheritance: filterConfig.override_inheritance ?? true
                    })
                })

                if (response.ok) {
                    generatedCount++
                } else {
                    console.warn(`[NUCLEAR-SYNC] ⚠️  Failed for ${category.name}: ${response.status}`)
                    failedCount++
                }
            } catch (error: any) {
                console.error(`[NUCLEAR-SYNC] ❌ Error for ${category.name}:`, error.message)
                failedCount++
            }
        }

        console.log(`[NUCLEAR-SYNC] 🎊 Complete! Generated: ${generatedCount}, Failed: ${failedCount}`)

        return res.json({
            success: true,
            phase1: {
                processed: processedCount,
                skipped: skippedCount
            },
            phase2: {
                generated: generatedCount,
                failed: failedCount
            }
        })

    } catch (error: any) {
        console.error('[NUCLEAR-SYNC] ❌ Failed:', error)
        return res.status(500).json({
            error: "Nuclear sync failed",
            message: error.message
        })
    }
}
