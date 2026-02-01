import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { syncCustomersCore } from "../../../../../lib/quickbooks/sync-customers-core"

/**
 * POST /admin/quickbooks/sync/customers
 * Syncs customers from QuickBooks to Medusa
 */
export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    try {
        // TODO: Move to background job for production
        const result = await syncCustomersCore(req.scope)

        if (!result.success) {
            res.status(500).json({
                error: result.error || "Sync failed",
                stats: result.stats
            })
            return
        }

        res.json({
            success: true,
            stats: result.stats,
            message: "Customer sync completed successfully"
        })

    } catch (error: any) {
        console.error("Error syncing customers:", error)
        res.status(500).json({
            error: "Failed to execute customer sync"
        })
    }
}
