import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { Modules } from "@medusajs/utils"
import { processDeactivateEstimateInQb } from "../../../../../lib/quickbooks/order-flow-core"
import { getEstimateTxnId, getEstimateRef } from "../../../../../lib/quickbooks/qb-metadata-types"

/**
 * POST /admin/draft-orders/:id/void
 *
 * Voids an estimate (draft order):
 *   1. Cancels the Medusa order via the ORDER module directly (no HTTP round-trip)
 *   2. Deactivates the linked QB Estimate (IsActive = false) — non-fatal
 *
 * The record is kept in the DB for audit purposes.
 */
export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const orderId = req.params.id

    if (!orderId) {
        res.status(400).json({ error: "orderId is required" })
        return
    }

    try {
        const orderModule = req.scope.resolve(Modules.ORDER) as any

        // ── 1. Fetch order to verify it exists and is still a draft ──────────
        let order: any
        try {
            order = await orderModule.retrieveOrder(orderId, {
                select: ["id", "display_id", "status", "is_draft_order", "metadata"],
            })
        } catch {
            res.status(404).json({ error: `Order ${orderId} not found` })
            return
        }

        if (!order.is_draft_order) {
            res.status(422).json({ error: "Only draft orders (estimates) can be voided from this endpoint" })
            return
        }

        if (order.status === "canceled") {
            res.status(422).json({ error: "Estimate is already canceled" })
            return
        }

        // ── 2. Stamp order_status + qb_sync_status before canceling ─────────
        const estimateTxnId = getEstimateTxnId(order.metadata)
        const estimateRef   = getEstimateRef(order.metadata)

        try {
            await orderModule.updateOrders(orderId, {
                metadata: {
                    ...(order.metadata || {}),
                    order_status:   "Voided",
                    qb_sync_status: estimateTxnId ? "voiding" : "voided",
                },
            })
        } catch { /* non-critical */ }

        // ── 3. Cancel via workflow (same pattern as invoice void for SR) ──────
        const { cancelOrderWorkflow } = await import("@medusajs/core-flows")
        try {
            await cancelOrderWorkflow(req.scope).run({ input: { order_id: orderId } })
        } catch (cancelErr: any) {
            console.error("[VoidEstimate] cancelOrderWorkflow failed:", cancelErr.message)
            res.status(500).json({ error: `Failed to cancel estimate: ${cancelErr.message}` })
            return
        }

        // ── 4. Deactivate QB Estimate — non-fatal ─────────────────────────────
        let qbDeactivated = false
        let qbSkipped     = false
        let qbError: string | undefined

        if (estimateTxnId) {

            const docNumber = (order.metadata?.document_number as string | undefined)
                ?? (order.display_id ? `E${order.display_id}` : undefined)

            const result = await processDeactivateEstimateInQb({
                draftOrderId:    orderId,
                estimateTxnId,
                estimateRef:     estimateRef ?? undefined,
                medusaRefNumber: docNumber,
            })

            if (!result.enabled) {
                qbSkipped = true
            } else if (result.error) {
                qbError = result.error
            } else {
                qbDeactivated = true
            }

            // Stamp final qb_sync_status
            try {
                await orderModule.updateOrders(orderId, {
                    metadata: {
                        ...(order.metadata || {}),
                        order_status:   "Voided",
                        qb_sync_status: qbDeactivated ? "voided" : (qbError ? "error" : "voided"),
                        voided_at:      new Date().toISOString(),
                    },
                })
            } catch { /* non-critical */ }
        } else {
            qbSkipped = true
        }

        res.json({
            success: true,
            orderId,
            qbDeactivated,
            qbSkipped,
            ...(qbError ? { qbError } : {}),
            message: qbDeactivated
                ? `Estimate voided and deactivated in QuickBooks (Ref: ${estimateRef ?? estimateTxnId})`
                : qbSkipped
                    ? "Estimate voided (no QB estimate linked)"
                    : `Estimate voided — QB deactivation failed: ${qbError}`,
        })

    } catch (err: any) {
        console.error("[VoidEstimate] Unexpected error:", err)
        res.status(500).json({ error: err.message || "Unknown error" })
    }
}
