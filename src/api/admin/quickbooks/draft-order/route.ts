import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { Modules } from "@medusajs/utils"
import { Client } from "pg"
import { parseSalesRepInitials } from "../../../../lib/quickbooks/parse-sales-rep"
import {
    ensureCustomerInQb,
    buildQbItems,
    buildShippingQbItem,
    buildQbOrderDiscountLines,
    processEstimateInQb,
    processUpdateEstimateInQb,
    processDeactivateEstimateInQb,
} from "../../../../lib/quickbooks/order-flow-core"
import {
    buildEstimatePatch,
    getEstimateTxnId,
    getEstimateRef,
} from "../../../../lib/quickbooks/qb-metadata-types"

/**
 * Reads QB order-flow settings from the DB config row.
 * Falls back to .env values if columns are null/missing.
 */
async function getQbConfig(): Promise<{ shippingItemId: string; defaultSalesTaxCode: string }> {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    try {
        await client.connect()
        const res = await client.query(
            `SELECT shipping_item_id, default_sales_tax_code FROM quickbooks_config WHERE id = 'default' LIMIT 1`
        )
        const row = res.rows[0] || {}
        return {
            shippingItemId: row.shipping_item_id || process.env.QB_SHIPPING_ITEM_ID || "800006A3-1395258131",
            defaultSalesTaxCode: row.default_sales_tax_code || process.env.QB_DEFAULT_SALES_TAX_CODE || "Sale Tax 7%",
        }
    } catch {
        // Fallback to env vars if DB fails
        return {
            shippingItemId: process.env.QB_SHIPPING_ITEM_ID || "800006A3-1395258131",
            defaultSalesTaxCode: process.env.QB_DEFAULT_SALES_TAX_CODE || "Sale Tax 7%",
        }
    } finally {
        await client.end()
    }
}

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
        // Load QB order-flow config from DB (shipping item ID + default tax code)
        const qbConfig = await getQbConfig()

        // Fetch via internal Medusa admin API — avoids cross-module relation errors
        // that occur when using orderModule.retrieveOrder with variant/product relations.
        const customerModule = req.scope.resolve(Modules.CUSTOMER)

        const baseUrl = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000"
        const orderResp = await fetch(
            `${baseUrl}/admin/orders/${orderId}?fields=id,display_id,status,metadata,tax_total,subtotal,discount_total,+items.*,+items.variant.*,+items.variant.metadata,+customer.*,+shipping_methods.*,+promotions.*,+promotions.application_method.*`,
            {
                headers: {
                    // Forward the admin auth cookie from the incoming request
                    cookie: req.headers.cookie || "",
                },
            }
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

        // Verify it's still a draft
        if (order.status !== "draft" && order.status !== "pending") {
            res.status(400).json({
                error: `Order ${orderId} is not a draft (status: ${order.status}). Use the regular order sync instead.`,
            })
            return
        }

        // Check if already synced — allow force re-sync via body.force=true
        // Guard 1: metadata txnId
        const existingEstimateTxnId = getEstimateTxnId(order.metadata)
        const existingEstimateRef = getEstimateRef(order.metadata)
        if (existingEstimateTxnId && !(req.body as any).force) {
            res.json({
                success: true,
                alreadySynced: true,
                qbEstimateTxnId: existingEstimateTxnId,
                qbEstimateRef: existingEstimateRef,
                message: `Already synced to QB Estimate #${existingEstimateRef || existingEstimateTxnId}`,
            })
            return
        }
        // Guard 2: pipeline table — catches cases where metadata wasn't saved but pipeline row was confirmed
        if (!(req.body as any).force) {
            try {
                const { getDbPool } = require("../../../utils/db-pool")
                const pool = getDbPool()
                const { rows: pipelineRows } = await pool.query(
                    `SELECT id, qb_txn_id, qb_ref_number FROM qb_order_pipeline
                     WHERE order_id = $1 AND step = 'estimate' AND status IN ('submitted','confirmed')
                     LIMIT 1`,
                    [orderId]
                )
                if (pipelineRows.length > 0) {
                    res.json({
                        success: true,
                        alreadySynced: true,
                        qbEstimateTxnId: pipelineRows[0].qb_txn_id,
                        qbEstimateRef: pipelineRows[0].qb_ref_number,
                        message: `Already synced to QB Estimate #${pipelineRows[0].qb_ref_number || pipelineRows[0].qb_txn_id} (confirmed in pipeline)`,
                    })
                    return
                }
            } catch {
                // Non-fatal — proceed with sync if pipeline check fails
            }
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

        const activeItems = (order.items || []).filter((item: any) => (item.quantity ?? 0) > 0)

        // ── Discount strategy ─────────────────────────────────────────────────
        // ALL DISCOUNTS → keep original item prices + Subtotal + Discount lines.
        // Admin/query API returns discount_total in DOLLARS — convert to cents.
        const orderDiscountDollars = Number((order as any).discount_total ?? 0)
        const orderDiscountTotal = Math.round(orderDiscountDollars * 100) // dollars → cents

        // Admin API returns unit_price in DOLLARS (e.g. 22.25).
        // buildQbItems expects unit_price in CENTS — multiply ×100 like the subscriber does.
        const itemsForQb = activeItems.map((item: any) => ({
            ...item,
            unit_price: Math.round((item.unit_price || 0) * 100), // dollars → cents
            subtotal: undefined, // force original price, ignore item-level adjustments
        }))

        const qbItems = buildQbItems(itemsForQb, order.metadata)

        // Append Subtotal + Discount BEFORE shipping so the QB Subtotal only sums products.
        // Shipping goes LAST — outside the Subtotal — so it's never included in the discount.
        if (orderDiscountTotal > 0) {
            const orderSubtotal = Math.round(Number((order as any).subtotal ?? 0) * 100) // dollars → cents
            const discountPercent = orderSubtotal > 0 ? (orderDiscountTotal / orderSubtotal) * 100 : null
            buildQbOrderDiscountLines(orderDiscountTotal, discountPercent).forEach(l => qbItems.push(l))
        }

        // Add shipping LAST — after Subtotal+Discount so it's not counted in the discount
        const shippingItem = buildShippingQbItem((order as any).shipping_methods || [], qbConfig.shippingItemId)
        if (shippingItem) qbItems.push(shippingItem)


        if (qbItems.length === 0) {
            res.status(400).json({
                error: "No active items in this draft order have a QuickBooks ID (variant.metadata.quickbooks_id). Add QB-linked products first.",
            })
            return
        }

        const isResync = !!(req.body as any).force && !!existingEstimateTxnId
        const isCancelled = (order.metadata?.order_status ?? order.metadata?.estimate_status) === "Cancelled" || (order.metadata?.order_status ?? order.metadata?.estimate_status) === "cancelled"
        const memo = `Draft Order #${(order as any).display_id || orderId} - ${customer.first_name || ""} ${customer.last_name || ""}`.trim()
        const salesRep = parseSalesRepInitials(order.metadata?.sales_rep)

        // ── Tax state: mirror Medusa's tax decision in QB ─────────────────────
        // Source of truth = draft order's tax_total (NOT customer defaults).
        //   tax_total === 0  →  taxExempt = true  →  QB gets "Exempt"
        //   tax_total  > 0  →  QB gets default_sales_tax_code from DB config
        const taxTotal = Number((order as any).tax_total ?? 0)
        const taxExempt = taxTotal === 0
        const salesTaxCode = taxExempt
            ? undefined
            : qbConfig.defaultSalesTaxCode

        let result
        if (isResync) {
            // ── RE-SYNC: edit existing estimate via EstimateMod ──────────────────
            // If the estimate was Cancelled (inactive in QB), auto-reactivate it
            result = await processUpdateEstimateInQb({
                draftOrderId: orderId,
                estimateTxnId: existingEstimateTxnId as string,
                items: qbItems,
                memo,
                taxExempt,
                salesTaxCode,
                ...(salesRep ? { salesRep } : {}),
                ...(isCancelled ? { isActive: true } : {}),
            })
        } else {
            // ── FIRST SYNC: create new estimate ───────────────────────────────
            result = await processEstimateInQb({
                draftOrderId: orderId,
                qbCustomerId,
                items: qbItems,
                memo,
                taxExempt,
                salesTaxCode,
                ...(salesRep ? { salesRep } : {}),
            })
        }

        if (!result.enabled) {
            res.status(503).json({ error: "QuickBooks integration is disabled. Check QB_ORDER_FLOW_ENABLED env var." })
            return
        }

        if (result.error) {
            res.status(500).json({ error: result.error })
            return
        }

        // Save QB metadata using patch builder
        if (result.txnId || isResync) {
            let metadataUpdate: Record<string, any>
            if (isResync) {
                // Re-sync: keep existing estimate ref/txnId, just update timestamp
                // (and reset estimate_status if reactivating from Cancelled)
                metadataUpdate = {
                    ...(order.metadata || {}),
                    qb_synced_at: new Date().toISOString(),
                    ...(isCancelled ? { order_status: "Created" } : {}),
                }
            } else {
                // New sync: write structured qb_estimate JSON
                metadataUpdate = buildEstimatePatch(order.metadata || {}, {
                    txnId:       result.txnId!,
                    refNumber:   result.refNumber || null,
                    operationId: result.operationId || null,
                })
                metadataUpdate.qb_list_id = qbCustomerId
            }

            await fetch(`${baseUrl}/admin/orders/${orderId}`, {
                method: "POST",
                headers: { "Content-Type": "application/json", cookie: req.headers.cookie || "" },
                body: JSON.stringify({ metadata: metadataUpdate }),
            })
        }

        const txnIdToReturn = isResync ? existingEstimateTxnId : result.txnId
        const refToReturn   = isResync ? existingEstimateRef    : result.refNumber

        res.json({
            success: true,
            alreadySynced: false,
            qbEstimateTxnId: txnIdToReturn,
            qbEstimateRef: refToReturn,
            operationId: result.operationId,
            message: txnIdToReturn
                ? (isResync
                    ? `✅ Estimate updated in QB! TxnID: ${txnIdToReturn}, Ref: ${refToReturn || "same"}`
                    : `✅ Estimate created in QB! TxnID: ${txnIdToReturn}, Ref: ${refToReturn || "pending"}`)
                : `⏳ Estimate queued in QB. OperationID: ${result.operationId}`,
        })
    } catch (err: any) {
        console.error("[QB] Error in manual draft order sync:", err)
        res.status(500).json({ error: err.message || "Unknown error" })
    }
}

/**
 * DELETE /admin/quickbooks/draft-order
 *
 * Deactivates the QB Estimate linked to a Draft Order (sets IsActive=false),
 * effectively unchecking the "Active" checkbox in QuickBooks Desktop.
 *
 * Called BEFORE deleting the Medusa draft order so the QB record is cleaned up.
 * Non-fatal: if QB is disabled or no estimate TxnID exists, returns success.
 *
 * Body: { orderId: string }
 */
export async function DELETE(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const { orderId } = req.body as { orderId: string }

    if (!orderId) {
        res.status(400).json({ error: "orderId is required" })
        return
    }

    try {
        const baseUrl = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000"

        // Fetch just the metadata we need (lightweight query)
        const orderResp = await fetch(
            `${baseUrl}/admin/orders/${orderId}?fields=id,display_id,status,metadata`,
            { headers: { cookie: req.headers.cookie || "" } }
        )

        if (!orderResp.ok) {
            // If we can't fetch the order (e.g. already deleted) — just return ok
            console.warn(`[QB] Cannot fetch order ${orderId} for QB deactivation: ${orderResp.status}`)
            res.json({ success: true, skipped: true, skipReason: "Order not found" })
            return
        }

        const { order } = await orderResp.json()
        // Read via compat helpers — supports both old flat fields and new JSON shape
        const estimateTxnId = getEstimateTxnId(order?.metadata)
        const estimateRef   = getEstimateRef(order?.metadata)

        if (!estimateTxnId) {
            // Draft order was never synced to QB — nothing to deactivate
            res.json({ success: true, skipped: true, skipReason: "No QB estimate linked to this draft order" })
            return
        }

        const result = await processDeactivateEstimateInQb({
            draftOrderId: orderId,
            estimateTxnId,
            estimateRef,
        })

        if (!result.enabled) {
            res.json({ success: true, skipped: true, skipReason: "QB integration disabled" })
            return
        }

        if (result.error) {
            // Return error but with 200 — frontend chooses whether to block deletion
            res.json({ success: false, error: result.error })
            return
        }

        res.json({
            success: true,
            operationId: result.operationId,
            txnId: result.txnId,
            message: `✅ Estimate ${estimateRef || estimateTxnId} deactivated in QuickBooks`,
        })

    } catch (err: any) {
        console.error("[QB] Error in draft order QB deactivation:", err)
        // Non-fatal — report error but don't block deletion
        res.json({ success: false, error: err.message || "Unknown error" })
    }
}
