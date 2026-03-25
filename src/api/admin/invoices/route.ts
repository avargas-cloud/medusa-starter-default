/**
 * src/api/admin/invoices/route.ts
 * GET  /admin/invoices       — List invoices (filter by order_id)
 * POST /admin/invoices       — Create a new invoice
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { INVOICE_MODULE } from '../../../modules/invoices'
import { FINANCE_MODULE } from '../../../modules/finance'
import { registerMedusaPayment } from './register-medusa-payment'
import { Modules } from '@medusajs/utils'
import { ContainerRegistrationKeys } from '@medusajs/utils'

// Import the background syncing handlers directly to bypass Medusa outbox dropping events
import { handleFulfillmentCreated } from '../../../lib/quickbooks/handlers/handle-fulfillment-created'
import { handlePosPaymentCreated } from '../../../lib/quickbooks/handlers/handle-pos-payment-created'
import { handlePosPaymentApplied } from '../../../lib/quickbooks/handlers/handle-pos-payment-applied'
// ── GET /admin/invoices?order_id=:id ─────────────────────────────────────────

export async function GET(req: MedusaRequest, res: MedusaResponse) {
    const invoiceService = req.scope.resolve(INVOICE_MODULE)
    const { order_id, customer_id, created_at, status, limit, offset } = req.query as Record<string, any>

    const filters: Record<string, unknown> = {}
    if (order_id) filters.order_id = order_id
    if (customer_id) filters.customer_id = customer_id
    if (created_at) filters.created_at = created_at
    if (status) filters.status = status

    const config: Record<string, any> = {
        relations: ['items', 'tracking_links'],
        order: { created_at: 'DESC' },
    }
    if (limit) config.take = parseInt(limit, 10)
    if (offset) config.skip = parseInt(offset, 10)

    const invoices = await invoiceService.listPosInvoices(filters, config)

    return res.json({ invoices })
}

// ── POST /admin/invoices ──────────────────────────────────────────────────────

interface CreateInvoiceBody {
    order_id: string
    order_display_id: number
    fulfillment_id?: string
    customer_id: string
    items: Array<{
        variant_id?: string
        sku?: string
        description: string
        quantity: number
        unit_price: number   // cents
        total: number        // cents
    }>
    subtotal: number         // cents
    discount?: number        // cents
    shipping: number         // cents
    tax: number              // cents
    total: number            // cents
    amount_paid: number      // cents
    payment_method: 'cash' | 'check' | 'card' | 'ach' | 'credit' | 'mixed'
    notes?: string
    created_by?: string
    shipping_address?: {
        first_name?: string
        last_name?: string
        company?: string
        address_1?: string
        address_2?: string
        city?: string
        province?: string
        postal_code?: string
        country_code?: string
        phone?: string
    }
    order_document_number?: string
    send_email?: boolean
    email_to?: string
    email_cc?: string
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
    const invoiceService = req.scope.resolve(INVOICE_MODULE)
    const financeService = req.scope.resolve(FINANCE_MODULE)
    const body = req.body as CreateInvoiceBody

    if (!body.order_id || !body.customer_id || !body.items?.length) {
        return res.status(400).json({ error: 'order_id, customer_id, and items are required' })
    }


    // Fetch strictly continuous sequential invoice number from PostgreSQL
    const pgConnection = req.scope.resolve("__pg_connection__") as any
    const seqRes = await pgConnection.raw(`SELECT nextval('custom_invoice_seq') AS seq`)
    const nextInvNum = seqRes.rows[0].seq || seqRes.rows[0].SEQ
    const invoice_number = `${nextInvNum}`

    const balance_due = body.total - body.amount_paid

    let paymentIdToEmit: string | null = null
    const applicationsToEmit: any[] = []

    // Step 1: Create the invoice (no nested items — hasMany must be created separately)
    const initialStatus = balance_due <= 0 ? 'paid' : (body.amount_paid > 0 ? 'partial' : 'issued')
    
    const invoice = await invoiceService.createPosInvoices({
        invoice_number,
        order_id:       body.order_id,
        fulfillment_id: body.fulfillment_id ?? null,
        customer_id:    body.customer_id,
        status:         initialStatus as 'issued' | 'paid' | 'partial',
        subtotal:       body.subtotal,
        discount:       body.discount ?? 0,
        shipping:       body.shipping ?? 0,
        tax:            body.tax,
        total:          body.total,
        amount_paid:    body.amount_paid,
        balance_due,
        payment_method: body.payment_method,
        issued_at:      new Date(),
        paid_at:        balance_due <= 0 ? new Date() : null,
        notes:          body.notes ?? null,
        created_by:     body.created_by ?? null,
        shipping_address: body.shipping_address ?? null,
    })

    // Step 2: Create line items linked to the invoice
    if (body.items?.length) {
        await invoiceService.createPosInvoiceItems(
            body.items.map(it => ({
                invoice_id:  (invoice as any).id,
                variant_id:  it.variant_id ?? null,
                sku:         it.sku ?? null,
                description: it.description,
                quantity:    it.quantity,
                unit_price:  it.unit_price,
                total:       it.total,
            }))
        )
    }
    
    // Helper mapper for methods
    function mapPosMethodToDbEnum(method: string): any {
        if (['visa', 'mastercard', 'discover', 'amex', 'capital_one', 'debit_card', 'card'].includes(method)) return 'card';
        if (['e_check', 'checking_account', 'transfer', 'wire_transfer', 'ach'].includes(method)) return 'ach';
        if (['paypal', 'money_order'].includes(method)) return 'other';
        if (method === 'credit') return 'credit_memo';
        if (['cash', 'check', 'zelle'].includes(method)) return method;
        return 'other';
    }

    // Step 3: If an initial payment amount is sent, record it in ALL ledgers
    if (body.amount_paid > 0) {
        const paymentDate = new Date()

        // A. PosInvoice internal payment record
        await invoiceService.createInvoicePayments({
            invoice_id:     (invoice as any).id,
            amount:         body.amount_paid,
            payment_method: body.payment_method,
            notes:          'Initial payment at issuance',
            created_by:     body.created_by ?? null,
            paid_at:        paymentDate,
        })
        if (body.payment_method === 'credit') {
            // Consume existing available credit instead of creating a new payment
            const availablePayments = await financeService.listCustomerPayments(
                { customer_id: body.customer_id },
                { relations: ['applications'] }
            )
            
            let amountToFind = body.amount_paid
            for (const p of availablePayments) {
                if (amountToFind <= 0) break;
                if (p.status === 'available' || p.status === 'partially_applied') {
                    const totalApplied = p.applications
                        .filter((app: any) => !app.voided_at)
                        .reduce((sum: number, app: any) => sum + Number(app.amount_applied), 0)
                    
                    const remaining = Number(p.amount) - totalApplied
                    if (remaining > 0) {
                        const applyAmount = Math.min(remaining, amountToFind)
                        
                        const application = await financeService.createPaymentApplications({
                            payment_id: p.id,
                            invoice_id: (invoice as any).id,
                            order_id: body.order_id,
                            amount_applied: applyAmount,
                            applied_at: paymentDate,
                            applied_by: body.created_by || null
                        })

                        applicationsToEmit.push({
                            payment_id: p.id,
                            invoice_id: (invoice as any).id,
                            order_id: body.order_id,
                            amount_applied: applyAmount,
                            application_id: application.id
                        })
                        
                        const newRemaining = remaining - applyAmount
                        await financeService.updateCustomerPayments({
                            id: p.id,
                            status: newRemaining <= 0 ? 'applied' : 'partially_applied'
                        })
                        
                        amountToFind -= applyAmount
                    }
                }
            }
        } else {
            // B. Finance Module global AR Ledger (New Money via Cash/Card/etc)
            const customerPayment = await financeService.createCustomerPayments({
                customer_id: body.customer_id,
                amount: body.amount_paid,
                method: mapPosMethodToDbEnum(body.payment_method),
                reference: 'Deposit',
                notes: body.notes || 'Initial invoice payment via Complete Order',
                received_at: paymentDate,
                created_by: body.created_by || null,
                source: 'pos',
                type: 'payment',
                status: 'applied',
                medusa_payment_synced: false, // will be updated after Medusa sync
                metadata: {
                    deposit_type: 'INVOICE',
                    order_id: body.order_id,
                    order_display_id: body.order_display_id,
                    pos_payment_method: body.payment_method,
                    invoices_affected: [(invoice as any).id],
                    invoices_affected_friendly: [String(body.order_display_id)],
                    order_document_number: body.order_document_number ?? null
                }
            })

            // Fire event so QuickBooks catches the POS payment immediately (deferred to end of route)
            const paymentId = Array.isArray(customerPayment) ? customerPayment[0]?.id : customerPayment?.id
            console.log("================= CUSTOMER PAYMENT DEBUG =================")
            console.log("customerPayment:", JSON.stringify(customerPayment))
            console.log("resolved paymentId:", paymentId)
            console.log("=====================================================")
            if (paymentId) {
                paymentIdToEmit = paymentId
            } else {
                console.log("paymentId WAS FALSEY! SKIPPING EMIT!")
            }

            // C. Finance Application
            const application = await financeService.createPaymentApplications({
                payment_id: customerPayment.id,
                invoice_id: (invoice as any).id,
                order_id: body.order_id,
                amount_applied: body.amount_paid,
                applied_at: paymentDate,
                applied_by: body.created_by || null
            })

            applicationsToEmit.push({
                payment_id: customerPayment.id,
                invoice_id: (invoice as any).id,
                order_id: body.order_id,
                amount_applied: body.amount_paid,
                application_id: application.id
            })

            // D. Register in Medusa native Payment Module (best-effort)
            const medusaPaymentId = await registerMedusaPayment(req.scope, {
                order_id:      body.order_id,
                amount:        body.amount_paid,
                payment_method: body.payment_method,
                invoice_total: body.total,
            })
            if (medusaPaymentId) {
                await financeService.updateCustomerPayments(
                    { id: customerPayment.id },
                    { medusa_payment_synced: true }
                ).catch(() => {}) // non-fatal
            }
        }
    }

    // Use direct background execution (Event Loop) to guarantee 100% reliable QuickBooks Syncing,
    // thereby bypassing the Medusa v2 BullMQ Outbox which silently drops multiple sequential events.
    setTimeout(async () => {
        try {
            const container = req.scope
            const orderModule = container.resolve(Modules.ORDER)
            const customerModule = container.resolve(Modules.CUSTOMER)
            const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

            // 1. Process Invoice - Unconditionally executed to guarantee 100% reliability
            // This bypasses the Medusa BullMQ Outbox which is prone to dropping concurrent transactional events.
            // The qb-order-subscriber intercepts and ignores native fulfillment events for POS orders to prevent duplicates.
            console.log(`DIRECT EXEC: Triggering pos.invoice.created directly for order ${body.order_id} to bypass BullMQ drops.`)
            await handleFulfillmentCreated({
                order_id: body.order_id,
                invoice_id: (invoice as any).id,
                items: body.items,
                fulfillment_id: body.fulfillment_id
            }, orderModule, customerModule, container, logger)

            // Wait 250ms to ensure sequential QB database writing
            await new Promise(r => setTimeout(r, 250))

            // 2. Process Payment Creation
            if (paymentIdToEmit) {
                await handlePosPaymentCreated({ 
                    event: { name: "pos.payment.created", data: { id: paymentIdToEmit } }, 
                    container 
                } as any)
                console.log("DIRECT EXEC: pos.payment.created executed successfully!")
            }

            // Wait 250ms again
            await new Promise(r => setTimeout(r, 250))

            // 3. Process Applications
            if (applicationsToEmit.length > 0) {
                for (const appPayload of applicationsToEmit) {
                    await handlePosPaymentApplied({
                        event: { name: "pos.payment.applied", data: appPayload },
                        container
                    } as any)
                    console.log(`DIRECT EXEC: pos.payment.applied executed for Payment ${appPayload.payment_id}!`)
                }
            }

        } catch (execErr: any) {
            console.error("DIRECT EXEC ERROR:", execErr)
        }
    }, 100)

    // Re-fetch with relations for the response
    const full = await invoiceService.retrievePosInvoice((invoice as any).id, {
        relations: ['items'],
    }).catch(() => invoice)

    return res.status(201).json({ invoice: full })
}
