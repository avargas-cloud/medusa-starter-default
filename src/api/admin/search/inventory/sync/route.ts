import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { syncInventoryWorkflow } from "../../../../../workflows/sync-inventory"

/**
 * POST /admin/search/inventory/sync
 * 
 * Synchronize all inventory items to MeiliSearch index
 * Now with smart sync verification (checks count + timestamp)
 */
export const POST = async (
    req: MedusaRequest,
    res: MedusaResponse
) => {
    try {
        const query = req.scope.resolve("query")

        // 1. Get MeiliSearch Stats (dynamic import for ESM compatibility)
        const { MeiliSearch } = await import("meilisearch")
        const client = new MeiliSearch({
            host: process.env.MEILISEARCH_HOST!,
            apiKey: process.env.MEILISEARCH_API_KEY!
        })

        let meiliCount = 0
        let meiliLastUpdate = new Date(0)

        try {
            const index = client.index("inventory")
            const stats = await index.getStats()
            meiliCount = stats.numberOfDocuments

            // Get latest updated_at from MeiliSearch
            const latestMeili = await index.search("", {
                limit: 1,
                sort: ["updated_at:desc"]
            })

            if (latestMeili.hits.length > 0) {
                const val = (latestMeili.hits[0] as any).updated_at
                if (val) meiliLastUpdate = new Date(val)
            }
        } catch (e) {
            // Index might not exist yet
        }

        // 2. Get DB Stats (using same query as sync workflow)
        const { data: variants } = await query.graph({
            entity: "product_variant",
            fields: [
                "id",
                "updated_at",
                "product.id",
                "inventory_items.inventory.id",
                "inventory_items.inventory.updated_at", // Added: must match sync workflow
            ],
        })

        // Transform to inventory items (same logic as sync workflow)
        const inventoryItems = variants.flatMap((variant: any) => {
            return variant.inventory_items?.map((invItem: any) => ({
                id: invItem.inventory?.id,
                variantId: variant.id,
                productId: variant.product?.id,
                updated_at: invItem.inventory?.updated_at || variant.updated_at // Match sync workflow
            })) || []
        })

        // Filter for valid items only (same logic as sync workflow - line 74)
        const validItems = inventoryItems.filter((item: any) => item.variantId && item.productId)
        const dbCount = validItems.length

        // Find latest update in DB (from valid items only)
        let dbLastUpdate = new Date(0)
        if (validItems.length > 0) {
            const latest = validItems.reduce((max: any, item: any) => {
                const itemDate = new Date(item.updated_at)
                return itemDate > new Date(max.updated_at) ? item : max
            })
            dbLastUpdate = new Date(latest.updated_at)
        }

        console.log(`🔍 [Inventory Sync Check] DB Valid: ${dbCount} (${inventoryItems.length} total, ${inventoryItems.length - dbCount} orphaned) | Meili: ${meiliCount}`)
        console.log(`🔍 [Inventory Sync Check] DB Last Upd: ${dbLastUpdate.toISOString()} | Meili: ${meiliLastUpdate.toISOString()}`)

        // 3. Check if sync is needed
        const isCountSync = dbCount === meiliCount
        const timeDiff = dbLastUpdate.getTime() - meiliLastUpdate.getTime()
        const isTimeSync = timeDiff <= 5000 // MeiliSearch can be up to 5s behind

        console.log(`🔍 [Inventory Sync Status] Count Match: ${isCountSync}, Time Diff: ${timeDiff}ms, Time Sync: ${isTimeSync}`)

        if (isCountSync && isTimeSync) {
            // Already synced
            console.log(`✅ [Inventory Sync] Already in sync!`)
            return res.json({
                success: true,
                synced: 0,
                status: "already_synced",
                message: "Inventory already synced"
            })
        }

        // 4. Perform full sync
        console.log(`🔄 [Inventory Sync] Starting full sync...`)
        const { result } = await syncInventoryWorkflow(req.scope).run({
            input: {}
        })

        return res.json({
            ...result,
            status: "synced"
        })

    } catch (error: any) {
        console.error("[MeiliSearch Inventory Sync Error]:", (error as Error).message)

        return res.status(500).json({
            success: false,
            error: "Sync failed",
            message: (error as Error).message,
        })
    }
}

// Middleware to protect this route (admin only)
export const AUTHENTICATE = ["user"]
