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
 *   1. Normalise promotion config (active, is_tax_inclusive=false, target_type=items)
 *   2. Cancel any pending order edits (clean slate)
 *   3. Begin a new draft order edit
 *   4. Add the promotion via workflow
 *   5. Pre-confirm: delete stale confirmed adjustments for this promo
 *   6. Confirm the edit → materialises new adjustments, recomputes order_summary
 *
 * WHY target_type = "items" (not "order"):
 *   - target_type "order" causes Medusa to compute the percentage against
 *     (item_subtotal + tax) — e.g. 5% × $371.95 = $18.60 ❌
 *   - target_type "items" causes Medusa to compute against each item's
 *     unit_price × quantity (pre-tax) — e.g. 5% × $347.62 = $17.38 ✓
 *
 * WHY is_tax_inclusive = false:
 *   - Belt-and-suspenders: ensures the promo value itself is treated as
 *     a pre-tax figure (mainly relevant for fixed-amount promos).
 *
 * Body:
 *   order_id       — draft order ID (order_XXXXX)
 *   promotion_code — promo code to apply
 *   promotion_id   — promo ID (used to look up the promo if needed)
 */

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function runWithLockRetry<T>(
    fn: () => Promise<T>,
    retries = 3,
    delayMs = 1500
): Promise<T> {
    let lastErr: any
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn()
        } catch (err: any) {
            if (err?.message?.includes('acquire lock') || err?.message?.includes('lock')) {
                lastErr = err
                if (attempt < retries) {
                    await sleep(delayMs)
                    continue
                }
            }
            throw err
        }
    }
    throw lastErr
}

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
    const knex = req.scope.resolve("__pg_connection__")

    try {
        // ── Step 0: Resolve promotion ID ──────────────────────────────────────
        const promotionModule = req.scope.resolve("promotion") as IPromotionModuleService

        let resolvedPromoId: string | undefined = promotion_id

        if (!resolvedPromoId) {
            const [promoByCode] = await promotionModule.listPromotions({ code: [promotion_code] } as any)
            resolvedPromoId = promoByCode?.id
        }

        // ── Step 1: Normalise promotion ───────────────────────────────────────
        //
        // Two critical fixes are applied every time a promo is applied:
        //
        // A) is_tax_inclusive = false
        //    Ensures the promo value is treated as pre-tax.
        //
        // B) application_method.target_type = "items"  ← THE KEY FIX
        //    When target_type = "order", Medusa computes the percentage against
        //    (item_subtotal + tax_total), giving an inflated discount.
        //    When target_type = "items", Medusa computes against each item's
        //    raw subtotal (unit_price × qty, pre-tax), which is correct.
        //
        if (resolvedPromoId) {
            const promo = await promotionModule.retrievePromotion(resolvedPromoId, {
                relations: ["application_method"],
            })

            const appMethod = (promo as any).application_method
            const needsPromoUpdate =
                promo.status !== "active" ||
                (promo as any).is_tax_inclusive === true

            if (needsPromoUpdate) {
                await promotionModule.updatePromotions({
                    id: resolvedPromoId,
                    status: "active",
                    is_tax_inclusive: false,
                } as any)
                logger.info(`[POS apply-existing] Normalised promotion ${promotion_code} → active, is_tax_inclusive=false`)
            }

            // Fix target_type via Knex (promotionModule.updatePromotions doesn't
            // reliably update nested application_method fields in Medusa v2)
            if (appMethod?.id && appMethod?.target_type !== "items") {
                await knex.raw(`
                    UPDATE promotion_application_method
                    SET target_type = 'items', updated_at = NOW()
                    WHERE id = ? AND deleted_at IS NULL
                `, [appMethod.id])
                logger.info(`[POS apply-existing] Fixed ${promotion_code} target_type: ${appMethod.target_type} → items`)
            }
        }

        // ── Step 2: Cancel any existing open order edits (clean slate) ────────
        try {
            await cancelDraftOrderEditWorkflow(req.scope).run({ input: { order_id } })
            logger.info(`[POS apply-existing] Cancelled existing draft order edit for ${order_id}`)
            await sleep(500)
        } catch {
            // No existing edit to cancel — that's fine
        }

        // ── Step 3: Begin a new draft order edit (with lock retry) ───────────
        await runWithLockRetry(
            () => beginDraftOrderEditWorkflow(req.scope).run({ input: { order_id } }),
            3, 1500
        )
        logger.info(`[POS apply-existing] Began draft order edit for ${order_id}`)

        // ── Step 4: Apply the promotion ───────────────────────────────────────
        await addDraftOrderPromotionWorkflow(req.scope).run({
            input: { order_id, promo_codes: [promotion_code] }
        })
        logger.info(`[POS apply-existing] Applied ${promotion_code} to order ${order_id}`)

        // ── Step 5: Delete stale confirmed adjustments BEFORE confirm ─────────
        //
        // addDraftOrderPromotionWorkflow stores new adjustments as PENDING
        // order_change_action records — NOT yet in order_line_item_adjustment.
        // confirmDraftOrderEditWorkflow will materialise those and recompute
        // order_summary.discount_total atomically.
        // Soft-deleting old confirmed adjustments BEFORE confirm ensures
        // only the fresh (correct) ones exist after confirm.
        try {
            const deleted = await knex.raw(`
                UPDATE order_line_item_adjustment
                SET deleted_at = NOW()
                WHERE deleted_at IS NULL
                  AND code = ?
                  AND item_id IN (
                      SELECT DISTINCT item_id FROM order_item
                      WHERE order_id = ? AND deleted_at IS NULL
                  )
            `, [promotion_code, order_id])
            logger.info(`[POS apply-existing] Pre-confirm: cleared stale ${promotion_code} adjustments — ${deleted.rowCount ?? 0} soft-deleted`)
        } catch (cleanupErr: any) {
            logger.warn(`[POS apply-existing] Pre-confirm cleanup failed (non-fatal): ${cleanupErr.message}`)
        }

        // ── Step 6: Confirm the edit ──────────────────────────────────────────
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
