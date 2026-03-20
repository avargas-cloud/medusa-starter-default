/**
 * src/api/admin/invoices/[id]/void/route.ts
 * POST /admin/invoices/:id/void — Void an issued invoice
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules } from "@medusajs/utils"
import { getDbPool } from '../../../../utils/db-pool'
import { INVOICE_MODULE } from '../../../../../modules/invoices'
import { FINANCE_MODULE } from '../../../../../modules/finance'

export async function POST(req: MedusaRequest, res: MedusaResponse) {
    const invoiceService = req.scope.resolve(INVOICE_MODULE)
    const financeService = req.scope.resolve(FINANCE_MODULE)
    const id = req.params.id!
    const { void_reason } = req.body as { void_reason?: string }

    console.log(`[VOID INVOICE START] ID: ${id}`)
    let invoice: any
    try {
        invoice = await invoiceService.retrievePosInvoice(id)
        console.log(`[VOID INVOICE] Retrieved invoice data:`, !!invoice, invoice.status)
    } catch {
        return res.status(404).json({ error: 'Invoice not found' })
    }

    if (invoice.status === 'voided') {
        console.log(`[VOID INVOICE] Encountered already voided invoice`)
        return res.status(409).json({ error: 'Invoice is already voided' })
    }

    // 0. SURGICAL FULFILLMENT & INVENTORY REVERSAL (Undo POS Physical Checkout)
    if (invoice.fulfillment_id && invoice.order_id) {
        console.log(`[VOID INVOICE] Surgical Fulfillment Reversal Triggered for Ful ID: ${invoice.fulfillment_id}`)
        const pool = getDbPool()
        const inventoryModule = req.scope.resolve(Modules.INVENTORY) as any
        
        // Force raw SQL fetch of invoice items to bypass DML empty array anomaly
        const invoiceItemsRes = await pool.query(
            `SELECT * FROM pos_invoice_item WHERE invoice_id = $1 AND deleted_at IS NULL`,
            [id]
        )
        const activeInvoiceItems = invoiceItemsRes.rows
        console.log(`[VOID INVOICE] Raw PG fetch found ${activeInvoiceItems.length} invoice items.`)

        // Fetch location where this was originally fulfilled to correctly return the stock
        const fulfillmentRes = await pool.query<{ location_id: string }>(
            `SELECT location_id FROM fulfillment WHERE id = $1 LIMIT 1`, 
            [invoice.fulfillment_id]
        )
        const locationId = fulfillmentRes.rows[0]?.location_id
        console.log(`[VOID INVOICE] Fulfillment Location Found: ${locationId}`)

        if (locationId) {
            // Get original order items line references via join with order_line_item
            const orderRes = await pool.query<{ id: string, variant_id: string, variant_sku: string }>(
                `SELECT oi.id, oli.variant_id, oli.variant_sku 
                 FROM order_item oi
                 JOIN order_line_item oli ON oi.item_id = oli.id
                 WHERE oi.order_id = $1`, 
                [invoice.order_id]
            )
            const orderItems = orderRes.rows
            console.log(`[VOID INVOICE] Retrieved ${orderItems.length} matching order items`)

            for (const posItem of activeInvoiceItems) {
                console.log(`[VOID INVOICE] Processing invoice line: ${posItem.description?.substring(0,30)} | variant_id: ${posItem.variant_id} | sku: ${posItem.sku} | qty: ${posItem.quantity}`)
                if (!posItem.quantity) continue;
                
                let reqItem = posItem.variant_id ? orderItems.find((oi: any) => oi.variant_id === posItem.variant_id) : undefined;
                if (!reqItem && posItem.sku) {
                    reqItem = orderItems.find((oi: any) => oi.variant_sku === posItem.sku)
                }

                if (!reqItem) {
                    console.log(`[VOID INVOICE] No matching order item found for invoice item ${posItem.description}. Skipping line.`)
                    continue;
                }

                const qtyToRevert = Number(posItem.quantity)
                console.log(`[VOID INVOICE] Reverting ${qtyToRevert} units for variant ${posItem.variant_id}`)
                
                // 0A. Raw SQL order_item fix (erase fulfilled/delivered progress natively)
                try {
                    await pool.query(
                         `UPDATE order_item 
                          SET fulfilled_quantity = GREATEST(COALESCE(fulfilled_quantity, 0) - $1, 0),
                              delivered_quantity = GREATEST(COALESCE(delivered_quantity, 0) - $1, 0)
                          WHERE id = $2`,
                         [qtyToRevert, reqItem.id]
                    )
                    console.log(`[VOID INVOICE] SQL order_item update success for ${reqItem.id}`)
                } catch(e) {
                    console.error(`[VOID INVOICE] SQL Error on order_item update:`, e)
                }

                // Locate the exact inventory reference to return physical stock
                const invItemRes = await pool.query<{ inventory_item_id: string }>(
                     `SELECT inventory_item_id FROM product_variant_inventory_item
                      WHERE variant_id = $1 AND deleted_at IS NULL LIMIT 1`,
                     [posItem.variant_id]
                )
                const inventoryItemId = invItemRes.rows[0]?.inventory_item_id
                
                if (inventoryItemId) {
                    console.log(`[VOID INVOICE] Re-adding physical inventory for Inv Item: ${inventoryItemId} at Location: ${locationId}`)
                    // 0B. Physically Put Stock Back On Shelf (+ qty)
                    await inventoryModule.adjustInventory(inventoryItemId, locationId, qtyToRevert)
                    
                    // 0C. Re-create the Reservation Item strictly bound to the un-fulfilled line item
                    try {
                        const { createReservationsWorkflow } = await import("@medusajs/core-flows")
                        await createReservationsWorkflow(req.scope).run({
                            input: {
                                reservations: [{
                                    inventory_item_id: inventoryItemId,
                                    location_id: locationId,
                                    quantity: qtyToRevert,
                                    line_item_id: reqItem.id,
                                    description: `Auto-restored via Void of Invoice ${invoice.invoice_number || invoice.id}`
                                }]
                            }
                        })
                        console.log(`[VOID INVOICE] createReservationsWorkflow Success`)
                    } catch(err) {
                        console.error("[Void Invoice] Could not recreate reservation item silently:", err)
                    }
                }
            }
        }
    } else {
        console.log(`[VOID INVOICE] Skipped physical rollback (missing fulfillment_id or order_id)`)
    }

    // 1. UNAPPLY ALL ATTACHED PAYMENTS FIRST (Free up customer balance)
    console.log(`[VOID INVOICE] Listing payment applications`)
    const dbApplications = await financeService.listPaymentApplications({ invoice_id: id }, {
        relations: ['payment']
    })
    
    // Only process applications that aren't already voided
    const activeApplications = dbApplications.filter((app: any) => !app.voided_at)
    console.log(`[VOID INVOICE] Found ${activeApplications.length} active applications to reverse`)

    let totalReversed = 0
    for (const app of activeApplications) {
        totalReversed += Number(app.amount_applied)

        // Void the application
        await financeService.updatePaymentApplications({
            id: app.id,
            voided_at: new Date(),
            void_reason: void_reason || `Auto-voided via invoice ${invoice.invoice_number || id} voiding`,
            voided_by: null // system
        })

        // Re-evaluate the source CustomerPayment status (partially_applied vs available)
        const currentPaymentDesc = await financeService.retrieveCustomerPayment(app.payment.id, {
            relations: ['applications']
        })
        
        // Filter out this newly voided application to check if anything else is still clinging to this payment
        const stillActive = currentPaymentDesc.applications.filter((a: any) => !a.voided_at && a.id !== app.id)
        const totalStillApplied = stillActive.reduce((sum: number, a: any) => sum + Number(a.amount_applied), 0)
        
        await financeService.updateCustomerPayments({
            id: currentPaymentDesc.id,
            status: totalStillApplied === 0 ? 'available' : 'partially_applied'
        })
        
        // Create an offsetting negative payment record in the Invoice ledger for auditing
        await invoiceService.createInvoicePayments({
            invoice_id: id,
            amount: -app.amount_applied,
            payment_method: 'credit',
            notes: `Auto-void unapply from payment ${app.payment.reference || app.payment.id}`,
            paid_at: new Date()
        })
        console.log(`[VOID INVOICE] Reversed application ${app.id} for amount ${app.amount_applied}`)
    }

    // 2. MARK INVOICE AS VOIDED & BALANCE TO 0
    console.log(`[VOID INVOICE] Calculating final invoice payments prior to void completion`)
    const finalInvoicePayments = await invoiceService.listInvoicePayments({ invoice_id: id })
    const finalTotalPaid = finalInvoicePayments.reduce((sum: number, p: any) => sum + Number(p.amount), 0)

    console.log(`[VOID INVOICE] Updating invoice ${id} totalPaid=${finalTotalPaid}`)
    
    // Use the explicit single-object DML signature
    const updated = await invoiceService.updatePosInvoices({
        id,
        amount_paid: 0, // Hard zero-out
        subtotal:    0,
        tax:         0,
        total:       0,
        balance_due: 0,
        status:     'voided',
        voided_at:  new Date(),
        void_reason: void_reason ?? null,
    })
    
    console.log(`[VOID INVOICE] Final API Response Payload ready. Success.`)

    return res.json({ invoice: updated, total_reversed: totalReversed })
}
