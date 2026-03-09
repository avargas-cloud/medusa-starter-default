import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { addDraftOrderPromotionWorkflow } from "@medusajs/core-flows"

export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const { order_id, promotion_code } = req.body as any

    if (!promotion_code) {
        res.status(400).json({ error: "Missing required field: promotion_code" })
        return
    }

    // If there's an active draft order, apply the promotion
    if (order_id && order_id.startsWith('dorder_')) {
        try {
            await addDraftOrderPromotionWorkflow(req.scope).run({
                input: {
                    order_id: order_id,
                    promo_codes: [promotion_code]
                }
            })
        } catch (err: any) {
            res.status(400).json({ error: err.message || "Failed to apply promotion to order" })
            return
        }
    }

    res.status(200).json({ success: true })
}
