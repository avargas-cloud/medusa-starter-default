import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { IPromotionModuleService } from "@medusajs/types"
import {
    beginDraftOrderEditWorkflow,
    addDraftOrderPromotionWorkflow,
    confirmDraftOrderEditWorkflow,
    cancelDraftOrderEditWorkflow,
} from "@medusajs/core-flows"

/**
 * POST /admin/pos-discount/apply-existing
 *
 * Applies a named Medusa promotion (e.g. GOOGLE-REVIEW) to a draft order
 * using the proper Medusa v2 Order Edit workflow:
 *   1. Cancel any pending order edits (clean slate)
 *   2. Begin a new draft order edit
 *   3. Add the promotion via workflow
 *   4. Confirm the edit
 *
 * Body:
 *   order_id       — draft order ID (order_XXXXX)
 *   promotion_code — promo code to apply
 *   promotion_id   — promo ID (used to activate if draft)
 */
export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const { order_id, promotion_code, promotion_id } = req.body as {
        order_id?: string
        promotion_code?: string
        promotion_id?: string
    }

    if (!order_id) { res.status(400).json({ error: "order_id is required" }); return }
    if (!promotion_code) { res.status(400).json({ error: "promotion_code is required" }); return }

    const logger = req.scope.resolve("logger")

    try {
        // Step 0: Activate the promotion if needed
        if (promotion_id) {
            const promotionModule = req.scope.resolve("promotion") as IPromotionModuleService
            const promo = await promotionModule.retrievePromotion(promotion_id)
            if (promo.status !== "active") {
                await promotionModule.updatePromotions({ id: promotion_id, status: "active" } as any)
                logger.info(`[POS apply-existing] Activated promotion ${promotion_code}`)
            }
        }

        // Step 1: Cancel any existing open order edits (so we start clean)
        try {
            await cancelDraftOrderEditWorkflow(req.scope).run({
                input: { order_id }
            })
            logger.info(`[POS apply-existing] Cancelled existing draft order edit for ${order_id}`)
        } catch {
            // No existing edit to cancel — that's fine
        }

        // Step 2: Begin a new draft order edit (creates an active Order Change)
        await beginDraftOrderEditWorkflow(req.scope).run({
            input: { order_id }
        })
        logger.info(`[POS apply-existing] Began draft order edit for ${order_id}`)

        // Step 3: Apply the promotion (now that there's an active Order Change)
        await addDraftOrderPromotionWorkflow(req.scope).run({
            input: { order_id, promo_codes: [promotion_code] }
        })
        logger.info(`[POS apply-existing] Applied ${promotion_code} to order ${order_id}`)

        // Step 4: Confirm the edit (commits the changes)
        await confirmDraftOrderEditWorkflow(req.scope).run({
            input: {
                order_id,
                confirmed_by: (req as any).auth_context?.actor_id ?? "pos-system"
            }
        })
        logger.info(`[POS apply-existing] Confirmed draft order edit for ${order_id}`)

        res.status(200).json({ success: true })

    } catch (err: any) {
        logger.error(`[POS apply-existing] Error: ${err.message}`)
        res.status(500).json({ error: err.message || "Failed to apply promotion" })
    }
}
