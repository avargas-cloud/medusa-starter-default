import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { syncInventoryWorkflow } from "../../../../../workflows/sync-inventory"

/**
 * POST /admin/search/inventory/sync
 * 
 * Synchronize all inventory items to MeiliSearch index
 * Called automatically when Inventory-Advanced page loads
 */
export const POST = async (
    req: MedusaRequest,
    res: MedusaResponse
) => {
    try {
        const { result } = await syncInventoryWorkflow(req.scope)
            .run({
                input: {}
            })

        return res.json({
            ...result
        })

    } catch (error: any) {
        console.error("[MeiliSearch Inventory Sync Error]:", error.message)

        return res.status(500).json({
            success: false,
            error: "Sync failed",
            message: error.message,
        })
    }
}

// Middleware to protect this route (admin only)
export const AUTHENTICATE = ["user"]
