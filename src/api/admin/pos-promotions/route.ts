import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { IPromotionModuleService } from "@medusajs/types"

export async function GET(
    req: MedusaRequest,
    res: MedusaResponse
) {
    const promotionModule = req.scope.resolve("promotion") as IPromotionModuleService

    try {
        const promotions = await promotionModule.listPromotions(
            { is_automatic: false },
            {
                relations: ["application_method"],
                take: 100
            }
        )

        const filteredPromotions = promotions.filter(p => !p.code?.startsWith('POS-DISC'))

        return res.json({ promotions: filteredPromotions })
    } catch (e: any) {
        req.scope.resolve("logger").error(`[POS GET PROMOS] Error: ${e.message}`)
        return res.status(500).json({ error: e.message })
    }
}
