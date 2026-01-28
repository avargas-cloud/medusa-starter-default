import { syncProductsWorkflow } from "../../../../../workflows/sync-products"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

/**
 * POST /admin/search/products/sync
 * 
 * Synchronize all products to MeiliSearch index
 * Called automatically when Advanced Search page loads
 */
export const POST = async (
    req: MedusaRequest,
    res: MedusaResponse
) => {
    try {
        const productModule = req.scope.resolve("product")
        const { MeiliSearch } = await import("meilisearch")

        // 1. Get MeiliSearch Stats
        const client = new MeiliSearch({
            host: process.env.MEILISEARCH_HOST!,
            apiKey: process.env.MEILISEARCH_API_KEY!,
        })
        const index = client.index("products")
        let meiliLastUpdate = new Date(0)
        let meiliCount = 0

        try {
            const stats = await index.getStats()
            meiliCount = stats.numberOfDocuments
            // MeiliSearch doesn't always expose "last updated" in getStats directly in all versions, 
            // but we can try getTask or just assume if counts differ. 
            // Actually, querying the latest 'updated_at' from Meili is more reliable.
            const latestMeili = await index.search("", {
                limit: 1,
                sort: ["updated_at:desc"],
                attributesToRetrieve: ["updated_at"]
            })
            if (latestMeili.hits.length > 0) {
                // Meili stores as unix timestamp (number)
                const val = latestMeili.hits[0].updated_at
                if (val) meiliLastUpdate = new Date(val)
            }
        } catch (e) {
            // Index might not exist
        }

        // 2. Get DB Stats
        const [latestProduct] = await productModule.listProducts({}, {
            select: ["updated_at"],
            order: { updated_at: "DESC" },
            take: 1
        })

        // Count products
        const [_, dbCount] = await productModule.listAndCountProducts({}, { select: ["id"], take: 0 })

        const dbLastUpdate = latestProduct ? new Date(latestProduct.updated_at) : new Date()

        console.log(`🔍 [Sync Check] DB Count: ${dbCount} | Meili Count: ${meiliCount}`)
        console.log(`🔍 [Sync Check] DB Last Upd: ${dbLastUpdate.toISOString()} | Meili: ${meiliLastUpdate.toISOString()}`)


        // 3. Check if sync is needed
        // Count must match
        const isCountSync = dbCount === meiliCount

        // MeiliSearch should be at least as recent as DB (with 5s tolerance for processing time)
        const timeDiff = dbLastUpdate.getTime() - meiliLastUpdate.getTime()
        const isTimeSync = timeDiff <= 5000 // MeiliSearch can be up to 5s behind

        console.log(`🔍[Sync Status] Count Match: ${isCountSync}, Time Diff: ${timeDiff}ms, Time Sync: ${isTimeSync}`)

        if (isCountSync && isTimeSync) {
            // Already synced
            console.log(`✅[Sync Check] Already in sync!`)
            return res.json({
                success: true,
                synced: 0,
                status: "already_synced",
                message: "Synced Already"
            })
        }

        // 4. Trigger Sync
        console.log(`⚠️[Sync Check] Out of sync, triggering workflow...`)
        const { result } = await syncProductsWorkflow(req.scope).run()

        return res.json({
            success: true,
            synced: result.synced,
            status: "synced_now",
            message: "Synced Now"
        })
    } catch (error: any) {
        console.error("[MeiliSearch Sync Error]:", error.message)
        return res.status(500).json({
            success: false,
            error: "Sync failed",
            message: error.message,
        })
    }
}

// Middleware to protect this route (admin only)
export const AUTHENTICATE = ["user"]
