import { syncCustomersWorkflow } from "../../../../../workflows/sync-customers"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

/**
 * POST /admin/search/customers/sync
 * 
 * Synchronize all customers to MeiliSearch index
 * Called automatically when Advanced Search page loads
 */
export const POST = async (
    req: MedusaRequest,
    res: MedusaResponse
) => {
    try {
        const customerModule = req.scope.resolve("customer")
        const query = req.scope.resolve("query")
        const { MeiliSearch } = await import("meilisearch")

        // 1. Get MeiliSearch Stats
        const client = new MeiliSearch({
            host: process.env.MEILISEARCH_HOST!,
            apiKey: process.env.MEILISEARCH_API_KEY!,
        })
        const index = client.index("customers")
        let meiliLastUpdate = new Date(0)
        let meiliCount = 0

        try {
            const stats = await index.getStats()
            meiliCount = stats.numberOfDocuments

            const latestMeili = await index.search("", {
                limit: 1,
                sort: ["updated_at:desc"],
                attributesToRetrieve: ["updated_at"]
            })

            if (latestMeili.hits.length > 0) {
                const val = latestMeili.hits[0].updated_at
                if (val) meiliLastUpdate = new Date(val)
            }
        } catch (e) { }

        // 2. Get DB Stats
        // Use query graph or module. Customer module `listAndCountCustomers`
        const [_, dbCount] = await customerModule.listAndCountCustomers({}, { select: ["id"], take: 0 })

        // Check latest customer
        const [latestCustomer] = await customerModule.listCustomers({}, {
            select: ["updated_at"],
            order: { updated_at: "DESC" },
            take: 1
        })
        const dbLastDate = latestCustomer ? new Date(latestCustomer.updated_at) : new Date(0)

        console.log(`🔍 [Customer Sync Check] DB: ${dbCount} | Meili: ${meiliCount}`)

        // 3. Compare (Count exact match)
        // 3. Compare (Count & Timestamp)
        const isCountSync = Math.abs(dbCount - meiliCount) === 0

        // 4. Time Check
        const isTimeSync = Math.abs(dbLastDate.getTime() - meiliLastUpdate.getTime()) < 2000 // 2s tolerance

        console.log(`🔍 [Customer Sync Check] DB: ${dbCount}, Last: ${dbLastDate.toISOString()} | Meili: ${meiliCount}, Last: ${meiliLastUpdate.toISOString()}`)

        if (isCountSync && isTimeSync && dbCount > 0) {
            return res.json({
                success: true,
                synced: 0,
                status: "already_synced",
                message: "Synced Already"
            })
        }

        const { result } = await syncCustomersWorkflow(req.scope).run()

        res.json({
            success: true,
            message: "Synced Now",
            status: "synced_now",
            synced: result.synced,
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
