/**
 * GET /admin/config/features
 *
 * Returns feature flags and system configuration for the admin UI.
 * Currently exposes:
 *   - enableDynamicPricing: from ENABLE_DYNAMIC_PRICING env var
 *   - priceLists: all active price lists in DB (for dynamic columns)
 */
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    try {
        const pricingService: any = req.scope.resolve(Modules.PRICING)

        const enableDynamicPricing =
            process.env.ENABLE_DYNAMIC_PRICING === "true"

        // Fetch all price lists — used by InventoryTable for dynamic columns
        let priceLists: { id: string; title: string }[] = []
        if (enableDynamicPricing) {
            const all = await pricingService.listPriceLists()
            priceLists = all.map((pl: any) => ({ id: pl.id, title: pl.title }))
        }

        return res.json({
            enableDynamicPricing,
            priceLists,
        })
    } catch (error: any) {
        return res.status(500).json({
            enableDynamicPricing: false,
            priceLists: [],
            error: error.message,
        })
    }
}

export const AUTHENTICATE = ["user"]
