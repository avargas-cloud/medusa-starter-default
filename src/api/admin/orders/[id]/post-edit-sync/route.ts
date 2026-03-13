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
    const { discount_type, discount_value, pos_total, pos_tax_amount } = req.body as {
        discount_type?: string
        discount_value?: number
        pos_total?: number  // POS-computed final total in dollars (includes tax, shipping, discounts)
        pos_tax_amount?: number // POS-computed tax in dollars
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

    // ── Apply Tax to Order Summary ──────────────────────────────────────────
    if (pos_tax_amount != null && pos_tax_amount > 0) {
        const dbUrl = process.env.DATABASE_URL
        if (dbUrl) {
            const pool = new Pool({ connectionString: dbUrl })
            try {
                const summaryRes = await pool.query<{ id: string; totals: any; version: number }>(
                    `SELECT id, totals, version FROM order_summary
                     WHERE order_id = $1 AND deleted_at IS NULL
                     ORDER BY version DESC LIMIT 1`,
                    [id]
                )
                if (summaryRes.rows[0]) {
                    const { id: summaryId, totals } = summaryRes.rows[0]
                    // Solo inyectamos el tax info visual para el Admin Panel
                    await pool.query(
                         `UPDATE order_summary SET totals = $1, updated_at = NOW() WHERE id = $2`,
                         [JSON.stringify({
                             ...totals,
                             tax_total: pos_tax_amount,
                             raw_tax_total: { value: String(pos_tax_amount), precision: 20 },
                         }), summaryId]
                    )
                    logger.info(`[post-edit-sync] ✅ Injected $${pos_tax_amount} tax to order_summary ${summaryId}`)
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

    res.status(200).json({ success: true, ...results })
}
