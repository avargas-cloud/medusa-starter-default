import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { Pool } from "pg"

/**
 * POST /admin/orders/:id/post-edit-sync
 *
 * Post-edit reconciliation for confirmed (non-draft) SALES orders.
 * Called after any force-update to items.
 *
 * Steps:
 *  1. DISCOUNT — apply-discount-force applies discount to ALL items + fixes payment collection
 *  (Allocation step removed — regular orders without inventory items cannot be allocated)
 *
 * Body: { promotion_code?, promotion_id?, discount_type?, discount_value? }
 *
 * NOTE: addDraftOrderPromotionWorkflow (Medusa's native promotion workflow) cannot run
 * on regular sales orders (requires is_draft_order=true). So we use apply-discount-force
 * which directly creates Order Module adjustments. Medusa admin discount_total won't
 * reflect these, but the payment collection will be correct.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const { id } = req.params as { id: string }
    const { discount_type, discount_value, pos_total, pos_tax_amount, pos_tax_rate } = req.body as {
        discount_type?: string
        discount_value?: number
        pos_total?: number  // POS-computed final total in dollars (includes tax, shipping, discounts)
        pos_tax_amount?: number // POS-computed tax in dollars
        pos_tax_rate?: number   // POS-computed tax rate (e.g. 7)
    }

    const base = `http://localhost:${process.env.PORT ?? 9000}`
    const authHeaders: Record<string, string> = {
        "Cookie": String(req.headers["cookie"] ?? ""),
        "Authorization": String(req.headers["authorization"] ?? ""),
        "Content-Type": "application/json",
    }
    const logger = req.scope.resolve("logger")
    const results: Record<string, any> = {}

    // ── Apply discount + fix payment collection ───────────────────────────────
    if (discount_type && discount_value && discount_value > 0) {
        try {
            const dr = await fetch(`${base}/admin/orders/${id}/apply-discount-force`, {
                method: "POST", headers: authHeaders,
                body: JSON.stringify({ discount_type, discount_value, pos_total }),
            })
            const dj = await dr.json().catch(() => ({}))
            if (dr.ok) {
                logger.info(`[post-edit-sync] ✅ apply-discount-force: ${JSON.stringify(dj)}`)
                results.discount = dj
            } else {
                logger.error(`[post-edit-sync] apply-discount-force failed: ${JSON.stringify(dj)}`)
                results.discount_error = dj?.message
            }
        } catch (e: any) {
            logger.error(`[post-edit-sync] apply-discount-force threw: ${e.message}`)
        }
    } else {
        // No discount — still fix payment collection to current order total
        try {
            const orderRes = await fetch(
                `${base}/admin/orders/${id}?fields=total,+payment_collections.*`,
                { headers: authHeaders }
            )
            if (orderRes.ok) {
                const { order } = await orderRes.json()
                // Use POS total if provided (includes tax), otherwise use Medusa's order total
                const correctTotal: number = (pos_total != null && pos_total > 0) ? pos_total : (order?.total ?? 0)
                const cols: any[] = order?.payment_collections ?? []
                logger.info(`[post-edit-sync] No discount — fixing payment: total=${correctTotal}, cols=${cols.length}`)
                const paymentModule = req.scope.resolve("payment" as any) as any
                for (const col of cols) {
                    await paymentModule.updatePaymentCollections(col.id, { amount: correctTotal })
                    logger.info(`[post-edit-sync] ✅ Payment updated to $${correctTotal}`)
                }
                results.payment_fixed = correctTotal
            }
        } catch (e: any) {
            logger.warn(`[post-edit-sync] Payment fix failed: ${e.message}`)
        }
    }

    // ── Apply Tax to Order Summary \u0026 Tax Lines ──────────────────────────────
    if (pos_tax_amount != null && pos_tax_amount > 0) {
        const dbUrl = process.env.DATABASE_URL
        if (dbUrl) {
            const pool = new Pool({ connectionString: dbUrl })
            try {
                // 1. Inyectar tax lines en los items (necesario para que Medusa Admin lo sume en el UI)
                const itemsRes = await pool.query<{ item_id: string }>(
                    `SELECT DISTINCT oi.item_id
                     FROM order_item oi
                     JOIN order_line_item oli ON oli.id = oi.item_id
                     WHERE oi.order_id = $1 AND oi.deleted_at IS NULL AND oli.deleted_at IS NULL`,
                    [id]
                )
                const itemIds = itemsRes.rows.map(r => r.item_id)
                
                if (itemIds.length > 0) {
                    await pool.query(
                        `DELETE FROM order_line_item_tax_line WHERE item_id = ANY($1) AND code = 'manual'`,
                        [itemIds]
                    )
                    
                    const taxRate = pos_tax_rate ?? 7 // Default to 7% if not provided
                    const rawRate = JSON.stringify({ value: String(taxRate), precision: 20 })
                    const genId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
                    
                    for (const itemId of itemIds) {
                        const lineId = genId("taxline")
                        await pool.query(
                            `INSERT INTO order_line_item_tax_line (id, item_id, code, rate, raw_rate, description, created_at, updated_at)
                             VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
                            [lineId, itemId, "manual", taxRate, rawRate, "Sales Tax"]
                        )
                    }
                    logger.info(`[post-edit-sync] ✅ Injected tax lines for ${itemIds.length} items`)
                }

                // 2. Inyectar en order_summary
                const summaryRes = await pool.query<{ id: string; totals: any; version: number }>(
                    `SELECT id, totals, version FROM order_summary
                     WHERE order_id = $1 AND deleted_at IS NULL
                     ORDER BY version DESC LIMIT 1`,
                    [id]
                )
                if (summaryRes.rows[0]) {
                    const { id: summaryId, totals } = summaryRes.rows[0]
                    
                    // We must patch ALL high level mathematical aggregations so Medusa doesn't calculate weirdly:
                    // new_accounting_total = (totals.original_order_total || 0) + tax_total - discount_total
                    // However, original_order_total already includes the tax... wait, original_order_total in medusa
                    // is strictly items + shipping BEFORE discounts but with their native taxes.
                    // Let's just hardcode the Final Math to the POS's exact numbers. The POS gave us `pos_tax_amount`.
                    
                    // Re-fetch the true discount from order_summary if apply-discount-force just set it
                    const forcedDiscount = totals.discount_total || 0
                    
                    // Assuming POS Total algorithm: 
                    // Item Subtotal (from order_item) + Shipping (from order_shipping_method)
                    // Let's just let Medusa keep original_order_total, but we force current_order_total and others.
                    
                    const newAccountingTotal = Number(totals.original_order_total || 0) + pos_tax_amount - forcedDiscount
                    
                    await pool.query(
                         `UPDATE order_summary SET totals = $1, updated_at = NOW() WHERE id = $2`,
                         [JSON.stringify({
                             ...totals,
                             tax_total: pos_tax_amount,
                             raw_tax_total: { value: String(pos_tax_amount), precision: 20 },
                             // Force the bottom-line variables so Admin UI doesn't look crazy
                             accounting_total: newAccountingTotal,
                             raw_accounting_total: { value: String(newAccountingTotal), precision: 20 },
                             current_order_total: newAccountingTotal,
                             raw_current_order_total: { value: String(newAccountingTotal), precision: 20 },
                             pending_difference: newAccountingTotal,
                             raw_pending_difference: { value: String(newAccountingTotal), precision: 20 }
                         }), summaryId]
                    )
                    logger.info(`[post-edit-sync] ✅ Injected $${pos_tax_amount} tax to order_summary ${summaryId} and fixed accounting_total`)
                    results.tax_injected = pos_tax_amount
                }
            } catch (e: any) {
                logger.error(`[post-edit-sync] Tax injection failed: ${e.message}`)
                results.tax_error = e.message
            } finally {
                await pool.end()
            }
        }
    }

    // ── Apply Hard Wipe of Stale Data ───────────────────────────────────────
    const dbUrl = process.env.DATABASE_URL
    if (dbUrl) {
        const pool = new Pool({ connectionString: dbUrl })
        try {
            // 1. Delete soft-deleted adjustments
            const adjDel = await pool.query(
                `DELETE FROM order_line_item_adjustment
                 WHERE deleted_at IS NOT NULL
                   AND item_id IN (SELECT DISTINCT item_id FROM order_item WHERE order_id = $1)`,
                [id]
            )
            logger.info(`[post-edit-sync] 🧹 Hard-deleted ${adjDel.rowCount ?? 0} stale adjustment row(s)`)

            // 2. Delete old order_change_action rows (keep only latest order_change)
            const ocaDel = await pool.query(
                `DELETE FROM order_change_action
                 WHERE order_change_id IN (
                     SELECT id FROM order_change WHERE order_id = $1
                     AND id != (SELECT id FROM order_change WHERE order_id = $2 ORDER BY created_at DESC LIMIT 1)
                 )`,
                [id, id]
            )
            logger.info(`[post-edit-sync] 🧹 Hard-deleted ${ocaDel.rowCount ?? 0} stale order_change_action row(s)`)

            // 3. Delete old order_change rows (keep only latest)
            const ocDel = await pool.query(
                `DELETE FROM order_change WHERE order_id = $1
                 AND id != (SELECT id FROM order_change WHERE order_id = $2 ORDER BY created_at DESC LIMIT 1)`,
                [id, id]
            )
            logger.info(`[post-edit-sync] 🧹 Hard-deleted ${ocDel.rowCount ?? 0} stale order_change row(s)`)

            // 4. Delete old order_item versions (keep only latest version per item)
            // also drops any stray order_item elements that aren't mapped in order_line_item if needed
            const oiDel = await pool.query(
                `DELETE FROM order_item
                 WHERE order_id = $1
                   AND (item_id, version) NOT IN (
                       SELECT item_id, MAX(version) FROM order_item WHERE order_id = $2 GROUP BY item_id
                   )`,
                [id, id]
            )
            logger.info(`[post-edit-sync] 🧹 Hard-deleted ${oiDel.rowCount ?? 0} stale order_item version(s)`)

            // 5. Delete old order_summary versions (keep only latest)
            const osDel = await pool.query(
                `DELETE FROM order_summary WHERE order_id = $1
                 AND version != (SELECT MAX(version) FROM order_summary WHERE order_id = $2)`,
                [id, id]
            )
            logger.info(`[post-edit-sync] 🧹 Hard-deleted ${osDel.rowCount ?? 0} stale order_summary version(s)`)
        } catch (e: any) {
            logger.warn(`[post-edit-sync] 🧹 Hard-wipe cleanup non-fatal: ${e.message}`)
        } finally {
            await pool.end()
        }
    }

    res.status(200).json({ success: true, ...results })
}
