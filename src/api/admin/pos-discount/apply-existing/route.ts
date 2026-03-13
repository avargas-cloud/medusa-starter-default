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

        // ── Step 1: Normalise promotion (ALWAYS — no conditional skips) ───────
        //
        // CRITICAL: We ALWAYS normalise, never skip. Skipping based on current
        // DB values is unsafe because the workflow reads from Medusa's ORM cache,
        // not the raw DB. If a previous request already patched the DB but the
        // ORM cache is stale, the workflow would still use the wrong settings.
        //
        // A) is_tax_inclusive = false  ← via ORM (updates the ORM cache)
        //    Prevents the promo value from being treated as tax-inclusive.
        //
        // B) application_method.target_type = "items"  ← THE KEY TAX FIX
        //    target_type = "order" → Medusa computes discount against
        //    (item_subtotal + tax_total), e.g. 10% × ($49.39 × 1.07) = $5.28 ❌
        //    target_type = "items" → Medusa computes against each item's
        //    raw unit_price × qty (pre-tax), e.g. 10% × $49.39 = $4.94 ✓
        //
        if (resolvedPromoId) {
            // Step 1a: Always update promotion-level fields via ORM so the
            // ORM cache is updated before the workflow reads the promotionModule.
            await (promotionModule as any).updatePromotions({
                id: resolvedPromoId,
                status: "active",
                is_tax_inclusive: false,
            })
            logger.info(`[POS apply-existing] Normalised promotion ${promotion_code} → active, is_tax_inclusive=false`)

            // Step 1b: Fetch fresh from ORM to get application_method ID.
            // This re-read also busts any stale cached data at this layer.
            const freshPromo = await promotionModule.retrievePromotion(resolvedPromoId, {
                relations: ["application_method"],
            })
            const appMethod = (freshPromo as any).application_method

            // Step 1c: Always fix target_type = "items" via Knex raw SQL.
            // We ALWAYS run this (not conditional on current value) because
            // Knex bypasses the ORM cache — the DB write is what matters for
            // the next step where the workflow reads from DB directly.
            if (appMethod?.id) {
                await knex.raw(`
                    UPDATE promotion_application_method
                    SET target_type = 'items', is_tax_inclusive = false, updated_at = NOW()
                    WHERE id = ? AND deleted_at IS NULL
                `, [appMethod.id])
                logger.info(`[POS apply-existing] Forced ${promotion_code} target_type=items, is_tax_inclusive=false on application_method (was: ${appMethod.target_type})`)

                // Step 1d: Re-fetch via ORM to force cache bust BEFORE the
                // workflow runs. This is the critical step that ensures the
                // workflow picks up the updated target_type from DB.
                await promotionModule.retrievePromotion(resolvedPromoId, {
                    relations: ["application_method"],
                })
                logger.info(`[POS apply-existing] ORM cache busted for ${promotion_code}`)
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
