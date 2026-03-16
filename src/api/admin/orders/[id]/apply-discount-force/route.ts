import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { Modules } from "@medusajs/utils"
import {
    createPromotionsWorkflow,
    addDraftOrderPromotionWorkflow,
    beginDraftOrderEditWorkflow,
    confirmDraftOrderEditWorkflow,
    cancelDraftOrderEditWorkflow,
} from "@medusajs/core-flows"
import { Pool } from "pg"

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
                is_tax_inclusive: false,
                application_method: {
                    type: discount_type === "percent" ? "percentage" : "fixed",
                    target_type: "items",
                    allocation: "across",
                    is_tax_inclusive: false,
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

            // 6. Mechanically remove old POS-DISC adjustments and `order_promotion` links so they don't stack
            const dbUrl = process.env.DATABASE_URL
            if (dbUrl) {
                const pool = new Pool({ connectionString: dbUrl })
                try {
                    const delAdj = await pool.query(
                        `DELETE FROM order_line_item_adjustment 
                         WHERE item_id IN (SELECT item_id FROM order_item WHERE order_id = $1)
                         AND (code LIKE 'POS-DISC-%' OR code LIKE 'CUSTOM-DISC-%' OR code LIKE 'ORDER-DISCOUNT-%')`,
                        [id]
                    )
                    const delPromo = await pool.query(
                        `DELETE FROM order_promotion WHERE order_id = $1`,
                        [id]
                    )
                    logger.info(`[apply-discount-force] Mechanically wiped ${delAdj.rowCount} old adjustments and ${delPromo.rowCount} promo links`)
                } catch (e: any) {
                    logger.warn(`[apply-discount-force] DB cleanup failed: ${e.message}`)
                } finally {
                    await pool.end()
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
            logger.info(`[apply-discount-force] Confirmed draft order edit`)

            // 9. Correct adjustment amounts from authoritative order_item (Bypass Workflow Lag)
            // Just like Estimates, the workflow snapshot has stale `qty` if items were edited via `update-item-force`.
            if (discount_value != null && discount_value > 0 && dbUrl) {
                const pool = new Pool({ connectionString: dbUrl })
                try {
                    const adjResult = await pool.query(`
                        SELECT a.id, a.item_id, a.amount
                        FROM order_line_item_adjustment a
                        WHERE a.code = $1 AND a.deleted_at IS NULL
                          AND a.item_id IN (SELECT DISTINCT item_id FROM order_item WHERE order_id = $2)
                    `, [promoCode, id])

                    logger.info(`[apply-discount-force] Found ${adjResult.rows.length} active adjustments for ${promoCode}`)

                    // First pass: collect authoritative totals (unit_price * quantity)
                    let orderSubtotal = 0
                    const itemData = new Map<string, { price: number, qty: number, lineTotal: number }>()
                    
                    for (const adj of adjResult.rows) {
                        const oiResult = await pool.query(`
                            SELECT unit_price, quantity
                            FROM order_item
                            WHERE item_id = $1 AND order_id = $2
                            ORDER BY version DESC LIMIT 1
                        `, [adj.item_id, id])

                        if (oiResult.rows.length > 0) {
                            const p = Number(oiResult.rows[0].unit_price)
                            const q = Number(oiResult.rows[0].quantity)
                            const lt = p * q
                            itemData.set(adj.id, { price: p, qty: q, lineTotal: lt })
                            orderSubtotal += lt
                        }
                    }

                    // Second pass: Update each adjustment depending on type
                    let discountAllocated = 0
                    const isLast = (index: number) => index === adjResult.rows.length - 1

                    for (let i = 0; i < adjResult.rows.length; i++) {
                        const adj = adjResult.rows[i]
                        const data = itemData.get(adj.id)
                        if (!data) continue

                        let correctAmount = 0
                        if (discount_type === "percent") {
                            // strictly math
                            const pct = discount_value / 100
                            correctAmount = Number((data.lineTotal * pct).toFixed(2))
                        } else if (discount_type === "fixed") {
                            // Prorate fixed discount over the subtotal sum
                            if (orderSubtotal > 0) {
                                if (isLast(i)) {
                                    // Allocate remainder to last item to prevent rounding gaps
                                    correctAmount = Number((discount_value - discountAllocated).toFixed(2))
                                } else {
                                    correctAmount = Number(((data.lineTotal / orderSubtotal) * discount_value).toFixed(2))
                                    discountAllocated += correctAmount
                                }
                            }
                        }

                        if (correctAmount < 0) correctAmount = 0
                        const rawAmountJson = JSON.stringify({ value: String(correctAmount), precision: 20 })

                        await pool.query(`
                            UPDATE order_line_item_adjustment
                            SET amount = $1, raw_amount = $2::jsonb, updated_at = NOW()
                            WHERE id = $3 AND deleted_at IS NULL
                        `, [correctAmount, rawAmountJson, adj.id])
                        logger.info(`[apply-discount-force] Corrected adj ${adj.id} to ${correctAmount} (${discount_type})`)
                    }

                    // Third pass: Force-update the `order_summary` discount_total
                    // Medusa's workflow confirm computes the summary *before* our corrections, 
                    // leaving it with the wrong prorated amounts. We must overwrite it.
                    const finalDiscountTotal = discount_type === "fixed" ? discount_value : discountAllocated
                    if (finalDiscountTotal > 0) {
                        const summaryRes = await pool.query(`
                            SELECT id, totals FROM order_summary
                            WHERE order_id = $1 AND deleted_at IS NULL
                            ORDER BY version DESC LIMIT 1
                        `, [id])

                        if (summaryRes.rows[0]) {
                            const { id: summaryId, totals } = summaryRes.rows[0]
                            await pool.query(
                                `UPDATE order_summary SET totals = $1, updated_at = NOW() WHERE id = $2`,
                                [JSON.stringify({
                                    ...totals,
                                    discount_total: finalDiscountTotal,
                                    raw_discount_total: { value: String(finalDiscountTotal), precision: 20 },
                                }), summaryId]
                            )
                            logger.info(`[apply-discount-force] ✅ Patched order_summary ${summaryId} discount_total to ${finalDiscountTotal}`)
                        }
                    }

                } catch (e: any) {
                    logger.warn(`[apply-discount-force] Adjustment correction non-fatal error: ${e.message}`)
                } finally {
                    await pool.end()
                }
            }

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
