import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { Modules } from "@medusajs/utils"
import {
    ensureCustomerInQb,
    buildQbItems,
    buildShippingQbItem,
    processOrderInQb,
} from "../../../../lib/quickbooks/order-flow-core"
import {
    updateSalesOrderInQb,
    pollOperationResult,
} from "../../../../lib/quickbooks/qb-bridge-client"
import { getQbConfig } from "../../../../lib/quickbooks/qb-config"

/**
 * POST /admin/quickbooks/order
 *
 * Manually triggers QuickBooks Sales Order creation/sync for a confirmed Medusa Order.
 *
 * If the order metadata has qb_estimate_txn_id → calls convertEstimateToSalesOrder() in QB.
 * If no estimate → creates a brand-new SalesOrderAdd in QB.
 *
 * Body: { orderId: string, force?: boolean }
 */
export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const { orderId, force } = req.body as { orderId: string; force?: boolean }

    if (!orderId) {
        res.status(400).json({ error: "orderId is required" })
        return
    }

    try {
        const qbConfig = await getQbConfig()
        const customerModule = req.scope.resolve(Modules.CUSTOMER)
        const baseUrl = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000"

        // Fetch full order via internal admin API (includes items, customer, shipping)
        const orderResp = await fetch(
            `${baseUrl}/admin/orders/${orderId}?fields=id,display_id,status,metadata,tax_total,+items.*,+items.variant.*,+items.variant.metadata,+customer.*,+shipping_methods.*`,
            { headers: { cookie: req.headers.cookie || "" } }
        )

        if (!orderResp.ok) {
            const errText = await orderResp.text()
            res.status(orderResp.status).json({ error: `Could not fetch order: ${errText}` })
            return
        }

        const { order } = await orderResp.json()

        if (!order) {
            res.status(404).json({ error: `Order ${orderId} not found` })
            return
        }

        // Only allow confirmed orders (not drafts)
        if (order.status === "draft") {
            res.status(400).json({
                error: "This is a Draft Order — use the Draft Order QB widget to sync as an Estimate first, then convert to a Sales Order.",
            })
            return
        }

        // If already synced — block unless force=true
        if (order.metadata?.qb_sales_order_txn_id && !force) {
            res.json({
                success: true,
                alreadySynced: true,
                qbSoTxnId: order.metadata.qb_sales_order_txn_id,
                qbSoRef: order.metadata.qb_sales_order_ref,
                message: `Already synced to QB Sales Order #${order.metadata.qb_sales_order_ref || order.metadata.qb_sales_order_txn_id}`,
            })
            return
        }

        const customer = (order as any).customer as any
        if (!customer) {
            res.status(400).json({ error: "Order has no customer assigned" })
            return
        }

        // Ensure customer exists in QB
        const custResult = await ensureCustomerInQb(customer, customerModule)
        if (!custResult.success) {
            res.status(500).json({ error: `QB customer error: ${custResult.error}` })
            return
        }

        // Build order items
        const activeItems = (order.items || [])
            .filter((item: any) => (item.quantity ?? 0) > 0)
            .map((item: any) => ({
                ...item,
                // ⚠️  Admin API returns unit_price in DOLLARS — pass directly to QB bridge.
                unit_price: item.unit_price || 0,
            }))

        const qbItems = buildQbItems(activeItems, order.metadata)

        // Add shipping line item
        const shippingItem = buildShippingQbItem((order as any).shipping_methods || [], qbConfig.shippingItemId)
        if (shippingItem) qbItems.push(shippingItem)

        if (qbItems.length === 0) {
            res.status(400).json({
                error: "No items with a QuickBooks ID found. Make sure products have variant.metadata.quickbooks_id set.",
            })
            return
        }

        // ─── RE-SYNC PATH (force=true + existing SO) — use SalesOrderMod ─────────
        const existingTxnId = order.metadata?.qb_sales_order_txn_id as string | undefined
        if (force && existingTxnId) {
            console.log(`[QB] Re-sync: updating existing Sales Order ${existingTxnId} via MOD`)

            const modResult = await updateSalesOrderInQb({
                txnId: existingTxnId,
                customerId: custResult.qbCustomerId,
                items: qbItems,
                memo: `Medusa Order #${(order as any).display_id || orderId}`,
                salesTaxCode: qbConfig.defaultSalesTaxCode,
            })

            if (!modResult.success) {
                res.status(500).json({ error: `QB Sales Order mod failed: ${modResult.error}` })
                return
            }

            // Poll for the mod result to get updated txnId/refNumber
            let txnId = existingTxnId
            let refNumber = order.metadata?.qb_sales_order_ref as string | undefined

            if (modResult.data?.operationId && modResult.data.operationId !== "DRY_RUN") {
                const polled = await pollOperationResult(modResult.data.operationId)
                txnId = polled.txnId || existingTxnId
                refNumber = polled.refNumber || refNumber
            }

            // Update metadata
            await fetch(`${baseUrl}/admin/orders/${orderId}`, {
                method: "POST",
                headers: { "Content-Type": "application/json", cookie: req.headers.cookie || "" },
                body: JSON.stringify({
                    metadata: {
                        ...(order.metadata || {}),
                        qb_sales_order_txn_id: txnId,
                        qb_sales_order_ref: refNumber || null,
                        qb_synced_at: new Date().toISOString(),
                    },
                }),
            })

            res.json({
                success: true,
                alreadySynced: false,
                resync: true,
                qbSoTxnId: txnId,
                qbSoRef: refNumber,
                operationId: modResult.data?.operationId,
                message: `✅ Sales Order updated in QB (MOD)! TxnID: ${txnId}, Ref: ${refNumber || "pending"}`,
            })
            return
        }

        // ─── INITIAL SYNC PATH — create new SO (Add or convert from Estimate) ────
        // IMPORTANT: pass activeItems with unit_price in DOLLARS (as returned by Admin API)
        // so that buildQbItems() constructs correct <Amount> values for QB Desktop.
        const orderForQb = {
            ...order,
            items: activeItems,   // ← dollars (Admin API values, passed directly to QB)
            customer,
            // Preserve estimate metadata so QB converts Estimate → SO (not create new)
            metadata: order.metadata || {},
        }

        const result = await processOrderInQb(orderForQb, customerModule, {
            prebuiltItems: qbItems,          // products + shipping (already built above)
            salesTaxCode: qbConfig.defaultSalesTaxCode,  // same tax code as the estimate
        })

        if (!result.enabled) {
            res.status(503).json({ error: "QuickBooks integration is disabled. Check QB_ORDER_FLOW_ENABLED env var." })
            return
        }
        if (result.skipped) {
            res.status(400).json({ error: `Skipped: ${result.skipReason}` })
            return
        }
        if (result.error) {
            res.status(500).json({ error: result.error })
            return
        }

        // Save QB metadata to the order
        const txnId = result.soTxnId
        const refNumber = result.soRefNumber

        if (txnId || result.operationId) {
            const metadataUpdate = {
                ...(order.metadata || {}),
                qb_sales_order_txn_id: txnId || null,
                qb_sales_order_ref: refNumber || null,
                qb_synced_at: new Date().toISOString(),
            }

            await fetch(`${baseUrl}/admin/orders/${orderId}`, {
                method: "POST",
                headers: { "Content-Type": "application/json", cookie: req.headers.cookie || "" },
                body: JSON.stringify({ metadata: metadataUpdate }),
            })
        }

        const isConversion = !!(order.metadata?.qb_estimate_txn_id)
        const action = isConversion ? "Estimate converted to Sales Order" : "Sales Order created"

        res.json({
            success: true,
            alreadySynced: false,
            qbSoTxnId: txnId,
            qbSoRef: refNumber,
            operationId: result.operationId,
            message: txnId
                ? `✅ ${action} in QB! TxnID: ${txnId}, Ref: ${refNumber || "pending"}`
                : `⏳ Sales Order queued in QB. OperationID: ${result.operationId}`,
        })
    } catch (err: any) {
        console.error("[QB] Error in manual order sync:", err)
        res.status(500).json({ error: err.message || "Unknown error" })
    }
}
