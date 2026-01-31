// @ts-nocheck - suppress type errors in admin tool
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

/**
 * Temporary admin endpoint to trigger full re-sync of all categories
 * 
 * POST /admin/product-categories/resync-all
 * 
 * This will re-calculate available_attributes for all categories
 * using the new recursive descendant logic.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const query = req.scope.resolve("query")

    console.log("🔄 [RESYNC-ALL] Starting full category re-sync...")

    try {
        // Fetch all categories
        const { data: allCategories } = await query.graph({
            entity: "product_category",
            fields: ["id", "name"]
        })

        console.log(`📦 [RESYNC-ALL] Found ${allCategories.length} categories`)

        const results = []

        for (const category of allCategories) {
            try {
                // Call sync-attributes for each category
                const response = await fetch(
                    `http://localhost:9000/admin/product-categories/${category.id}/sync-attributes`,
                    {
                        method: "POST",
                        headers: {
                            Cookie: req.headers.cookie || "",
                            Authorization: req.headers.authorization || "",
                            "Content-Type": "application/json"
                        }
                    }
                )

                if (response.ok) {
                    const result = await response.json()
                    results.push({
                        category: category.name,
                        success: true,
                        attributeCount: result.attributeCount,
                        productCount: result.productCount
                    })
                } else {
                    results.push({
                        category: category.name,
                        success: false,
                        error: `HTTP ${response.status}`
                    })
                }
            } catch (error: any) {
                results.push({
                    category: category.name,
                    success: false,
                    error: error.message
                })
            }

            // Small delay to avoid overwhelming the server
            await new Promise(resolve => setTimeout(resolve, 50))
        }

        const successCount = results.filter(r => r.success).length
        const errorCount = results.filter(r => !r.success).length

        console.log(`✅ [RESYNC-ALL] Complete: ${successCount} success, ${errorCount} errors`)

        return res.json({
            success: true,
            totalCategories: allCategories.length,
            successCount,
            errorCount,
            results
        })
    } catch (error: any) {
        console.error(`❌ [RESYNC-ALL] Error:`, error.message)
        return res.status(500).json({
            error: "Failed to resync categories",
            message: error.message
        })
    }
}
