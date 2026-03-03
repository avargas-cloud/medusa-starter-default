import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { Modules } from "@medusajs/utils"
import {
    ensureCustomerInQb,
    buildQbItems,
    processEstimateInQb,
} from "../../../../lib/quickbooks/order-flow-core"

/**
 * POST /admin/quickbooks/draft-order/sync
 *
 * Manually triggers a QuickBooks Estimate creation for a Draft Order.
 * Called by the admin widget "Save to QuickBooks" button.
 *
 * Body: { orderId: string }
 */
export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const { orderId } = req.body as { orderId: string }

    if (!orderId) {
        res.status(400).json({ error: "orderId is required" })
        return
    }

    try {
        const orderModule = req.scope.resolve(Modules.ORDER)
        const customerModule = req.scope.resolve(Modules.CUSTOMER)

        // Fetch the draft order with all needed relations
        const order = await orderModule.retrieveOrder(orderId, {
            relations: [
                "items",
                "items.variant",
                "items.variant.product",
                "customer",
                "customer.addresses",
                "shipping_address",
            ],
        })

        if (!order) {
            res.status(404).json({ error: `Order ${orderId} not found` })
            return
        }

        // Verify it's still a draft
        if (order.status !== "draft" && order.status !== "pending") {
            res.status(400).json({
                error: `Order ${orderId} is not a draft (status: ${order.status}). Use the regular order sync instead.`,
            })
            return
        }

        // Check if already synced
        if (order.metadata?.qb_estimate_txn_id) {
            res.json({
                success: true,
                alreadySynced: true,
                qbEstimateTxnId: order.metadata.qb_estimate_txn_id,
                qbEstimateRef: order.metadata.qb_estimate_ref,
                message: `Already synced to QB Estimate #${order.metadata.qb_estimate_ref || order.metadata.qb_estimate_txn_id}`,
            })
            return
        }

        // Get customer (cast needed: OrderDTO doesn't statically expose customer
        // even though it's returned when fetched with the customer relation)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const customer = (order as any).customer as any
        if (!customer) {
            res.status(400).json({ error: "Draft order has no customer assigned" })
            return
        }

        // Ensure customer exists in QB
        const custResult = await ensureCustomerInQb(customer, customerModule)
        if (!custResult.success) {
            res.status(500).json({ error: `QB customer error: ${custResult.error}` })
            return
        }
        const qbCustomerId = custResult.qbCustomerId!

        // Build QB items
        const qbItems = buildQbItems(order.items as any)
        if (qbItems.length === 0) {
            res.status(400).json({
                error: "No items in this draft order have a QuickBooks ID (variant.metadata.quickbooks_id). Add QB-linked products first.",
            })
            return
        }

        // Create Estimate in QB
        const result = await processEstimateInQb({
            draftOrderId: orderId,
            qbCustomerId,
            items: qbItems,
            memo: `Draft Order #${(order as any).display_id || orderId} — ${customer.first_name || ""} ${customer.last_name || ""}`.trim(),
        })

        if (!result.enabled) {
            res.status(503).json({ error: "QuickBooks integration is disabled. Check QB_ORDER_FLOW_ENABLED env var." })
            return
        }

        if (result.error) {
            res.status(500).json({ error: result.error })
            return
        }

        // Save QB metadata to the order
        if (result.txnId) {
            await orderModule.updateOrders(orderId, {
                metadata: {
                    ...(order.metadata as Record<string, any> || {}),
                    qb_estimate_txn_id: result.txnId,
                    qb_estimate_ref: result.refNumber || result.txnId,
                    qb_list_id: qbCustomerId,
                    qb_synced_at: new Date().toISOString(),
                },
            })
        }

        res.json({
            success: true,
            alreadySynced: false,
            qbEstimateTxnId: result.txnId,
            qbEstimateRef: result.refNumber,
            operationId: result.operationId,
            message: result.txnId
                ? `✅ Estimate created in QB! TxnID: ${result.txnId}, Ref: ${result.refNumber || "pending"}`
                : `⏳ Estimate queued in QB. OperationID: ${result.operationId}`,
        })
    } catch (err: any) {
        console.error("[QB] Error in manual draft order sync:", err)
        res.status(500).json({ error: err.message || "Unknown error" })
    }
}
