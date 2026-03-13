import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { Modules } from "@medusajs/utils"
import {
    createPromotionsWorkflow,
    addDraftOrderPromotionWorkflow,
    removeDraftOrderPromotionsWorkflow,
    beginDraftOrderEditWorkflow,
    confirmDraftOrderEditWorkflow,
    cancelDraftOrderEditWorkflow,
} from "@medusajs/core-flows"

/**
 * POST /admin/orders/:id/apply-discount-force
 *
 * Applies a percentage or fixed discount to a confirmed (non-draft) order
 * using the SAME native Medusa workflow as pos-discount, by temporarily
 * setting is_draft_order = true so the validation passes, then restoring it.
 *
 * This ensures discount_total shows correctly in Medusa Admin.
 *
 * Body: { discount_type: 'percent' | 'fixed', discount_value: number }
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const { id } = req.params as { id: string }
    const { discount_type, discount_value, pos_total } = req.body as {
        discount_type: 'percent' | 'fixed'
        discount_value: number
        pos_total?: number  // POS-computed final total in dollars (includes tax, shipping, discounts)
    }

    if (!discount_type || !discount_value) {
        return void res.status(400).json({ message: "discount_type and discount_value are required" })
    }

    const base = `http://localhost:${process.env.PORT ?? 9000}`
    const authHeaders: Record<string, string> = {
        "Cookie": String(req.headers["cookie"] ?? ""),
        "Authorization": String(req.headers["authorization"] ?? ""),
        "Content-Type": "application/json",
    }
    const logger = req.scope.resolve("logger")
    const orderModule = req.scope.resolve(Modules.ORDER) as any
    const paymentModule = req.scope.resolve(Modules.PAYMENT) as any

    try {
        // 1. Fetch order to get currency code and payment collections
        const orderRes = await fetch(
            `${base}/admin/orders/${id}?fields=currency_code,+payment_collections.*`,
            { headers: authHeaders }
        )
        if (!orderRes.ok) return void res.status(400).json({ message: "Could not fetch order" })
        const { order } = await orderRes.json()
        const paymentCollections: any[] = order?.payment_collections ?? []

        // 2a. Delete ALL old raw line item adjustments (from previous createOrderLineItemAdjustments approach)
        //     These were NOT created through the promotion engine so they stack with the new promotion.
        // We need to re-fetch items with adjustments for cleanup
        const itemsRes = await fetch(`${base}/admin/orders/${id}?fields=+items.*,+items.adjustments.*`, { headers: authHeaders })
        if (itemsRes.ok) {
            const { order: orderWithItems } = await itemsRes.json()
            for (const item of (orderWithItems?.items ?? [])) {
                const rawAdjs = (item.adjustments ?? []).filter((a: any) => !a.tax_line_id && !a.promotion_id)
                if (rawAdjs.length > 0) {
                    await orderModule.deleteOrderLineItemAdjustments(rawAdjs.map((a: any) => a.id))
                    logger.info(`[apply-discount-force] Cleaned ${rawAdjs.length} old raw adjustments from item ${item.id}`)
                }
            }
        }

        // 2b. Temporarily flip is_draft_order = true so native workflows accept it
        logger.info(`[apply-discount-force] Flipping is_draft_order=true for ${id}`)
        await orderModule.updateOrders(id, { is_draft_order: true })

        let promotionCode: string | null = null
        let promotionId: string | null = null

        try {
            // 3. Create a real Medusa promotion (same as pos-discount does for draft orders)
            const promoCode = `POS-DISC-${Date.now()}`
            const promotionData: any = {
                code: promoCode,
                type: "standard",
                status: "active",
                is_automatic: false,
                application_method: {
                    type: discount_type === "percent" ? "percentage" : "fixed",
                    target_type: "order",
                    value: discount_value,
                    currency_code: discount_type === "fixed" ? (order.currency_code ?? "usd") : undefined,
                }
            }

            const { result: createdPromos } = await createPromotionsWorkflow(req.scope).run({
                input: { promotionsData: [promotionData] }
            })
            const promotion = createdPromos[0]
            if (!promotion) throw new Error("Failed to create promotion")
            promotionCode = promoCode
            promotionId = promotion.id
            logger.info(`[apply-discount-force] Created promotion ${promoCode}`)

            // 4. Cancel any pending edits (clean slate)
            try {
                await cancelDraftOrderEditWorkflow(req.scope).run({ input: { order_id: id } })
            } catch { /* no existing edit — OK */ }

            // 5. Begin a new edit
            await beginDraftOrderEditWorkflow(req.scope).run({ input: { order_id: id } })

            // 6. Remove any old POS-DISC promotions so they don't stack
            const existingPromoRes = await fetch(
                `${base}/admin/orders/${id}?fields=+promotions.*`,
                { headers: authHeaders }
            )
            if (existingPromoRes.ok) {
                const { order: orderWithPromos } = await existingPromoRes.json()
                const oldCodes: string[] = (orderWithPromos?.promotions ?? [])
                    .map((p: any) => p.code)
                    .filter((c: string) => c?.startsWith("POS-DISC-") || c?.startsWith("CUSTOM-DISC-"))
                if (oldCodes.length > 0) {
                    try {
                        await removeDraftOrderPromotionsWorkflow(req.scope).run({
                            input: { order_id: id, promo_codes: oldCodes }
                        })
                        logger.info(`[apply-discount-force] Removed old promos: ${oldCodes.join(", ")}`)
                    } catch (e: any) {
                        logger.warn(`[apply-discount-force] Could not remove old promos: ${e.message}`)
                    }
                }
            }

            // 7. Apply the new promotion (now passes because is_draft_order=true)
            await addDraftOrderPromotionWorkflow(req.scope).run({
                input: { order_id: id, promo_codes: [promoCode] }
            })
            logger.info(`[apply-discount-force] Applied promotion ${promoCode} to order ${id}`)

            // 8. Confirm the edit
            await confirmDraftOrderEditWorkflow(req.scope).run({
                input: { order_id: id, confirmed_by: "pos-system" }
            })

        } finally {
            // 9. ALWAYS restore is_draft_order = false (even if something fails above)
            logger.info(`[apply-discount-force] Restoring is_draft_order=false for ${id}`)
            await orderModule.updateOrders(id, { is_draft_order: false }).catch((e: any) => {
                logger.error(`[apply-discount-force] CRITICAL: Could not restore is_draft_order=false for ${id}: ${e.message}`)
            })
        }

        // 10. Use pos_total if provided (includes POS-computed tax which Medusa doesn't apply automatically),
        //     otherwise re-fetch from Medusa
        let correctTotal: number = 0
        if (pos_total != null && pos_total > 0) {
            correctTotal = pos_total
            logger.info(`[apply-discount-force] Using POS total = ${correctTotal} (includes tax)`)
        } else {
            try {
                const refreshedRes = await fetch(`${base}/admin/orders/${id}?fields=total`, { headers: authHeaders })
                if (refreshedRes.ok) {
                    const { order: refreshedOrder } = await refreshedRes.json()
                    correctTotal = refreshedOrder?.total ?? 0
                    logger.info(`[apply-discount-force] Refreshed order total = ${correctTotal}`)
                }
            } catch (e: any) {
                logger.warn(`[apply-discount-force] Re-fetch failed: ${e.message}`)
            }
        }

        // 11. Fix payment collection to match the real post-discount total
        for (const col of paymentCollections) {
            logger.info(`[apply-discount-force] Updating payment col ${col.id}: ${col.amount} → ${correctTotal}`)
            try {
                await paymentModule.updatePaymentCollections(col.id, { amount: correctTotal })
                logger.info(`[apply-discount-force] ✅ Payment collection updated to ${correctTotal}`)
            } catch (e: any) {
                logger.error(`[apply-discount-force] Payment module update failed: ${e.message}`)
            }
        }

        res.status(200).json({
            success: true,
            promotion_code: promotionCode,
            promotion_id: promotionId,
            correct_total: correctTotal,
        })
    } catch (e: any) {
        logger.error("[apply-discount-force]", e?.message)
        res.status(500).json({ message: e?.message ?? "Failed to apply discount" })
    }
}
