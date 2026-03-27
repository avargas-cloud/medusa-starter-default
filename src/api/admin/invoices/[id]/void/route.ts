/**
 * src/api/admin/invoices/[id]/void/route.ts
 * POST /admin/invoices/:id/void — Void an issued invoice
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules } from "@medusajs/utils"
import { getDbPool } from '../../../../utils/db-pool'
import { INVOICE_MODULE } from '../../../../../modules/invoices'
import { FINANCE_MODULE } from '../../../../../modules/finance'
import { recalculateOrderStatus } from '../../../../../utils/order-utils'

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
            const orderRes = await pool.query<{ id: string, line_item_id: string, variant_id: string, variant_sku: string }>(
                `SELECT oi.id, oli.id as line_item_id, oli.variant_id, oli.variant_sku 
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
                     [reqItem.variant_id]
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
                                    line_item_id: reqItem.line_item_id,
                                    allow_backorder: true,
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

        // Re-evaluate the source CustomerPayment status (partially_applied vs available vs voided)
        const currentPaymentDesc = await financeService.retrieveCustomerPayment(app.payment.id, {
            relations: ['applications']
        })
        
        // Filter out this newly voided application to check if anything else is still clinging to this payment
        const stillActive = currentPaymentDesc.applications.filter((a: any) => !a.voided_at && a.id !== app.id)
        const totalStillApplied = stillActive.reduce((sum: number, a: any) => sum + Number(a.amount_applied), 0)
        
        const isSRPayment = currentPaymentDesc.metadata?.is_sales_receipt_payment === true
        
        await financeService.updateCustomerPayments({
            id: currentPaymentDesc.id,
            status: isSRPayment ? 'voided' : (totalStillApplied === 0 ? 'available' : 'partially_applied'),
            notes: isSRPayment ? ((currentPaymentDesc.notes || '') + `\nAuto-voided via Sales Receipt ${invoice.invoice_number || id} voiding`).trim() : currentPaymentDesc.notes
        })
        
        // D. Refund Native Medusa Payment (best effort, to keep ledger synced)
        try {
            const query = req.scope.resolve('query')
            const paymentModule = req.scope.resolve('payment')
            const { data: [order] } = await query.graph({
                entity: 'order',
                fields: ['payment_collections.payments.id', 'payment_collections.payments.amount', 'payment_collections.payments.captures.*', 'payment_collections.payments.refunds.*'],
                filters: { id: invoice.order_id }
            })
            if (order?.payment_collections?.length) {
                let amountToRefund = Number(app.amount_applied) // dollars removed, kept natively in cents
                for (const pc of order.payment_collections) {
                    if (amountToRefund <= 0) break
                    
                    if (pc) {
                        // Find a fully captured base payment
                        const payment = pc.payments?.find((p: any) => p.captured_at && !p.canceled_at)
                        if (payment) {
                            const availableForRefund = Number(payment.amount) - Number(payment.refunds?.reduce((sum: number, r: any) => sum + Number(r.amount), 0) || 0)
                            const refundChunk = Math.min(amountToRefund, availableForRefund)

                            if (availableForRefund > 0 && refundChunk > 0) {
                                console.log(`[VOID INVOICE] Proceeding with Native Refund of ${refundChunk} cents from Payment ${payment.id}`)
                                
                                await paymentModule.refundPayment({
                                    payment_id: payment.id,
                                    amount: refundChunk,
                                    created_by: "pos-void-hook",
                                    note: `Auto-refunded via Void of Invoice ${invoice.invoice_number || invoice.id}`
                                }).catch((e: any) => console.error("[VOID INVOICE] Refund failed for payment", payment.id, e.message))
                                
                                console.log(`[VOID INVOICE] Native Refund Successful for Payment ${payment.id}`)
                                amountToRefund -= refundChunk
                            } else {
                                console.warn(`[VOID INVOICE] Payment ${payment.id} does not have enough unrefunded balance (${availableForRefund} vs ${refundChunk}). Cannot auto-refund.`)
                            }
                        } else {
                            console.warn(`[VOID INVOICE] No fully captured payment found in PaymentCollection ${pc.id}. Cannot auto-refund.`)
                        }
                    }
                }
            }
        } catch (e: any) {
            console.error(`[VOID INVOICE] Non-fatal error refunding native Medusa payment: ${e.message}`)
        }
        
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
        discount:    0,
        shipping:    0,
        tax:         0,
        total:       0,
        balance_due: 0,
        status:     'voided',
        voided_at:  new Date(),
        void_reason: void_reason ?? null,
    })

    // Also zero out individual item amounts so reports don't pick up 'fake' historical line items
    try {
        const pool = getDbPool()
        await pool.query(
            `UPDATE pos_invoice_item SET unit_price = 0, total = 0 WHERE invoice_id = $1 AND deleted_at IS NULL`,
            [id]
        )
        console.log(`[VOID INVOICE] Zeroed out items for invoice ${id}`)
    } catch (e: any) {
        console.error(`[VOID INVOICE] Non-fatal error zeroing out invoice items: ${e.message}`)
    }
    
    // 3. DYNAMICALLY REVERT PARENT MEDUSA ORDER STATUSES
    if (invoice.order_id) {
        if (invoice.fulfillment_id) {
            try {
                // Medusa natively blocks canceling a Fulfillment once it has been "Shipped" 
                // Since this is a POS hard-void, we surgically revert the item counts and nuke the physical tree.
                const pool = getDbPool()
                
                // 1. Find the exact quantities that were fulfilled in THIS specific fulfillment
                const fItems = await pool.query(
                    `SELECT line_item_id, quantity FROM fulfillment_item WHERE fulfillment_id = $1 AND deleted_at IS NULL`, 
                    [invoice.fulfillment_id]
                )

                // 2. Reverse the counts in Medusa's high-precision JSONB schema
                for (const fItem of fItems.rows) {
                     // Reverse fulfilled quantity
                     await pool.query(`
                        UPDATE order_item 
                        SET 
                            fulfilled_quantity = GREATEST(0, fulfilled_quantity - $1::numeric),
                            raw_fulfilled_quantity = jsonb_set(
                                raw_fulfilled_quantity, 
                                '{value}', 
                                to_jsonb(GREATEST(0, (raw_fulfilled_quantity->>'value')::numeric - $1::numeric)::text), 
                                false
                            )
                        WHERE item_id = $2
                     `, [fItem.quantity, fItem.line_item_id])
                     
                     // The allocated (reservation) quantity is natively restored by createReservationsWorkflow in Step 0C.
                     // We previously ran a manual SQL update here that caused duplicate allocations.
                }

                // 3. Delete the fulfillment records
                await pool.query(`UPDATE fulfillment_label SET deleted_at = NOW() WHERE fulfillment_id = $1`, [invoice.fulfillment_id])
                await pool.query(`UPDATE fulfillment_item SET deleted_at = NOW() WHERE fulfillment_id = $1`, [invoice.fulfillment_id])
                await pool.query(`UPDATE order_fulfillment SET deleted_at = NOW() WHERE fulfillment_id = $1`, [invoice.fulfillment_id])
                await pool.query(`UPDATE fulfillment SET deleted_at = NOW(), canceled_at = NOW() WHERE id = $1`, [invoice.fulfillment_id])
                
                console.log(`[VOID INVOICE] Surgically Nuked native fulfillment ${invoice.fulfillment_id}`)
            } catch (fErr: any) {
                console.warn(`[VOID INVOICE] Could not nuke fulfillment natively:`, fErr.message)
            }
        }
        
        // Oracle calculation based purely on order items stock and active POS Invoices
        await recalculateOrderStatus(invoice.order_id, req.scope)

        // 4. CANCEL DIRECT SALES ORDERS ENTIRELY
        const isSalesReceipt = invoice.metadata?.is_sales_receipt === true || invoice.qb_ref_number?.startsWith?.('SR-') || invoice.invoice_number?.startsWith?.('SR-')
        if (isSalesReceipt) {
            try {
                const { cancelOrderWorkflow } = await import("@medusajs/core-flows")
                console.log(`[VOID INVOICE] Canceling Medusa order ${invoice.order_id} natively since it was a Direct Sale`)
                
                await cancelOrderWorkflow(req.scope).run({
                    input: { order_id: invoice.order_id }
                })
                console.log(`[VOID INVOICE] Successfully native-canceled Medusa Order ${invoice.order_id}`)
            } catch (cErr: any) {
                console.warn(`[VOID INVOICE] Could not natively cancel Medusa Order ${invoice.order_id}:`, cErr.message)
            }
        }
    }
    
    const eventBus = req.scope.resolve(Modules.EVENT_BUS)
    await eventBus.emit({
        name: "pos.invoice.voided",
        data: {
            order_id: invoice.order_id,
            invoice_id: id,
            fulfillment_id: invoice.fulfillment_id ?? null,
        }
    })

    console.log(`[VOID INVOICE] Final API Response Payload ready. Success.`)

    return res.json({ invoice: updated, total_reversed: totalReversed })
}
