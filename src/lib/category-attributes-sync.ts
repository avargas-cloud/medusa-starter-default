/**
 * Simplified category sync - calls internal API endpoint with auth
 * 
 * Fixed to capture headers in closure to avoid race conditions
 */
export function scheduleCategoryUpdate(categoryId: string, scope: any, headers?: any): void {
    console.log(`🔄 [SCHEDULER] Scheduling update for ${categoryId}, has headers: ${!!headers}, cookie: ${!!headers?.cookie}`)

    // Debounce: only create ONE timer per category
    if (!pendingCategories.has(categoryId)) {
        pendingCategories.add(categoryId)

        // ⭐ CAPTURE headers in closure (don't use Map)
        const capturedHeaders = {
            cookie: headers?.cookie || "",
            authorization: headers?.authorization || ""
        }

        setTimeout(async () => {
            // Remove from pending set
            pendingCategories.delete(categoryId)

            console.log(`🚀 [SCHEDULER] Executing update for ${categoryId}, captured cookie: ${!!capturedHeaders.cookie}`)

            try {
                // Call internal API endpoint with auth headers
                const response = await fetch(
                    `http://localhost:9000/admin/product-categories/${categoryId}/sync-attributes`,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "Cookie": capturedHeaders.cookie,
                            "Authorization": capturedHeaders.authorization
                        }
                    }
                )

                if (!response.ok) {
                    console.error(`❌ [CATEGORY-ATTRS] Failed to sync category ${categoryId}: ${response.status}`)
                } else {
                    console.log(`✅ [CATEGORY-ATTRS] Successfully queued sync for ${categoryId}`)
                }
            } catch (error: any) {
                console.error(`❌ [CATEGORY-ATTRS] Error syncing category ${categoryId}:`, error.message)
            }
        }, 2000)
    } else {
        console.log(`⏭️  [SCHEDULER] Category ${categoryId} already pending, skipping duplicate`)
    }
}

const pendingCategories = new Set<string>()
