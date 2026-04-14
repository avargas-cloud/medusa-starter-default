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
import { handleSalesReceiptCreated } from '../../../lib/quickbooks/handlers/handle-sales-receipt-created'
import { writePipelineRow, skipSalesOrderPipelineRow, skipPendingPaymentRows } from '../../../lib/quickbooks/qb-pipeline'
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
    is_sales_receipt?: boolean
    /** If set, a CustomerPayment was already created by the terminal route — skip creating a new one and link this ID instead */
    terminal_payment_id?: string
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
    const invoiceService = req.scope.resolve(INVOICE_MODULE)
    const financeService = req.scope.resolve(FINANCE_MODULE)
    const body = req.body as CreateInvoiceBody

    if (!body.order_id || !body.customer_id || !body.items?.length) {
        return res.status(400).json({ error: 'order_id, customer_id, and items are required' })
    }

    // ── Path B detection (auto-downgrade Sales Receipt → Invoice) ─────────────
    // If the order already has a QB Sales Order or Estimate, OR the order is
    // more than 1 hour old, we cannot create a Sales Receipt — QB Desktop requires
    // an Invoice linked to the existing SO/Estimate. Silently downgrade to keep
    // the POS flow frictionless; accounting reviews documents downstream.
    if (body.is_sales_receipt) {
        try {
            const orderModule = req.scope.resolve(Modules.ORDER)
            const order = await orderModule.retrieveOrder(body.order_id, {
                select: ['id', 'created_at', 'metadata'],
            }) as any
            const meta = order?.metadata ?? {}
            const hasExistingQbDoc = Boolean(
                meta.qb_sales_order_txn_id
             || meta.qb_estimate_txn_id
             || meta.qb_sales_order?.txn_id
             || meta.qb_estimate?.txn_id
            )
            const createdAt = order?.created_at ? new Date(order.created_at).getTime() : Date.now()
            const ageMs = Date.now() - createdAt
            const ONE_HOUR_MS = 60 * 60 * 1000
            if (hasExistingQbDoc || ageMs > ONE_HOUR_MS) {
                console.warn(
                    `[invoice] Path B detected for order ${body.order_id} — ` +
                    `downgrading is_sales_receipt=true → false. ` +
                    `hasExistingQbDoc=${hasExistingQbDoc}, ageMs=${ageMs}`
                )
                body.is_sales_receipt = false
            }
        } catch (pbErr: any) {
            console.warn(`[invoice] Path B detection failed for order ${body.order_id}: ${pbErr.message}`)
        }
    }

    // Fetch strictly continuous sequential document number from PostgreSQL
    const pgConnection = req.scope.resolve("__pg_connection__") as any
    
    // 1. Get Medusa Invoice Sequence
    const medusaSeqRes = await pgConnection.raw(`SELECT nextval('custom_medusa_invoice_seq') AS seq`)
    const invoice_number = `${medusaSeqRes.rows[0].seq || medusaSeqRes.rows[0].SEQ}`

    // 2. Get QB RefNumber Sequence
    const targetSeq = body.is_sales_receipt ? 'custom_sales_receipt_seq' : 'custom_invoice_seq'
    const seqRes = await pgConnection.raw(`SELECT nextval('${targetSeq}') AS seq`)
    const nextInvNum = seqRes.rows[0].seq || seqRes.rows[0].SEQ
    const qb_metadata_ref_number = `${nextInvNum}`

    const balance_due = body.total - body.amount_paid

    let paymentIdToEmit: string | null = null
    let nextPayNum: number | null = null
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
        untaxed_total:  body.total - body.tax,
        total:          body.total,
        amount_paid:    body.amount_paid,
        balance_due,
        payment_method: body.payment_method,
        issued_at:      new Date(),
        paid_at:        balance_due <= 0 ? new Date() : null,
        notes:          body.notes ?? null,
        created_by:     body.created_by ?? null,
        shipping_address: body.shipping_address ?? null,
        metadata: {
            is_sales_receipt: !!body.is_sales_receipt,
            qb_ref_number: qb_metadata_ref_number
        }
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
                            invoice_number: String(invoice_number || body.order_display_id || ''),
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
        } else if (body.terminal_payment_id) {
            // B-terminal. The CustomerPayment was already created by the terminal route.
            // Just link it to this invoice via a PaymentApplication — no new payment row.
            //
            // For sales receipts the QB handler embeds the payment internally (same as the
            // manual flow), so we must NOT set paymentIdToEmit — otherwise handlePosPaymentCreated
            // would fire a second time and create a duplicate QB entry.
            if (!body.is_sales_receipt) {
                paymentIdToEmit = body.terminal_payment_id

                // Look up the existing payment's display_id for QB pipeline ref
                const termPayRes = await pgConnection.raw(
                    `SELECT display_id FROM customer_payment WHERE id = ?`,
                    [body.terminal_payment_id]
                ).catch(() => ({ rows: [{ display_id: null }] }))
                nextPayNum = termPayRes.rows[0]?.display_id ? Number(termPayRes.rows[0].display_id) : null
            } else {
                // Sales Receipt: tag the terminal payment so it is treated as embedded.
                // This prevents handlePosPaymentCreated from ever creating a separate
                // ReceivePayment in QB for this payment, and gives the SR handler a way
                // to locate and txn-id the payment after the SR confirms.
                try {
                    const termPay = await financeService.retrieveCustomerPayment(body.terminal_payment_id)
                    await financeService.updateCustomerPayments({
                        id: body.terminal_payment_id,
                        metadata: {
                            ...((termPay as any)?.metadata || {}),
                            qb_source: 'sales_receipt',
                            qb_sync_status: 'pending_sr',
                            invoices_affected: [(invoice as any).id],
                            invoices_affected_friendly: [`IN-${invoice_number || body.order_display_id}`],
                        },
                    })
                } catch (tagErr: any) {
                    console.warn(`[invoice] Could not tag terminal payment ${body.terminal_payment_id} as SR-embedded: ${tagErr.message}`)
                }
            }

            const application = await financeService.createPaymentApplications({
                payment_id:      body.terminal_payment_id,
                invoice_id:      (invoice as any).id,
                invoice_number:  String(invoice_number || body.order_display_id || ''),
                order_id:        body.order_id,
                amount_applied:  body.amount_paid,
                applied_at:      new Date(),
                applied_by:      body.created_by || null,
            })

            applicationsToEmit.push({
                payment_id:     body.terminal_payment_id,
                invoice_id:     (invoice as any).id,
                order_id:       body.order_id,
                amount_applied: body.amount_paid,
                application_id: application.id,
            })

            // Always mark the terminal payment as fully applied once we link it,
            // regardless of SR or regular-invoice mode. Previously this only ran in
            // the non-SR branch, leaving SR-linked payments stuck on status='available'.
            await financeService.updateCustomerPayments(
                { id: body.terminal_payment_id },
                { status: 'applied' }
            ).catch(() => {})

        } else {
            // Fetch strictly continuous sequential payment number
            const seqPgRes = await pgConnection.raw(`SELECT nextval('custom_payment_seq') AS seq`).catch(() => ({ rows: [{ seq: null }] }))
            nextPayNum = seqPgRes.rows[0]?.seq || seqPgRes.rows[0]?.SEQ ? Number(seqPgRes.rows[0].seq || seqPgRes.rows[0].SEQ) : null

            // B. Finance Module global AR Ledger (New Money via Cash/Card/etc)
            const customerPayment = await financeService.createCustomerPayments({
                customer_id: body.customer_id,
                display_id: nextPayNum,
                amount: body.amount_paid,
                method: mapPosMethodToDbEnum(body.payment_method),
                reference: 'Deposit',
                notes: 'Initial invoice payment via Complete Order',
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
                    invoices_affected:          [(invoice as any).id],
                    invoices_affected_friendly: [`IN-${invoice_number || body.order_display_id}`],
                    order_document_number: body.order_document_number ?? null,
                    ...(body.is_sales_receipt 
                        ? { 
                            qb_txn_id: "SYNCED_VIA_RECEIPT", 
                            is_sales_receipt_payment: true
                          } 
                        : {
                            ...(process.env.QB_ORDER_FLOW_ENABLED === "true" ? { qb_sync_status: 'pending' } : {})
                          })
                }
            })

            // Fire event so QuickBooks catches the POS payment immediately (deferred to end of route)
            const paymentId = Array.isArray(customerPayment) ? customerPayment[0]?.id : customerPayment?.id
            console.log("================= CUSTOMER PAYMENT DEBUG =================")
            console.log("customerPayment:", JSON.stringify(customerPayment))
            console.log("resolved paymentId:", paymentId)
            console.log("=====================================================")
            if (paymentId) {
                if (body.is_sales_receipt) {
                    console.log("PAYMENT SKIPPED FOR EMIT: Sales receipt covers payment automatically.")
                } else {
                    paymentIdToEmit = paymentId
                }
            } else {
                console.log("paymentId WAS FALSEY! SKIPPING EMIT!")
            }

            // C. Finance Application
            const application = await financeService.createPaymentApplications({
                payment_id: customerPayment.id,
                invoice_id: (invoice as any).id,
                invoice_number: String(invoice_number || body.order_display_id || ''),
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

    // Write upfront pipeline rows immediately so the UI shows the complete expected flow
    // before any QB handler runs. Each row starts as 'waiting' and transitions in-place.
    if (process.env.QB_ORDER_FLOW_ENABLED === "true") {
        try {
            if (body.is_sales_receipt) {
                // ── Sales Receipt flow ────────────────────────────────────────
                // Payment is embedded in the Sales Receipt — QB handles it internally.
                // Cancel any stale/preexisting payment pipeline rows first (e.g. from
                // terminal capture that wrote a row before the SR decision was made).
                try {
                    const cancelled = await skipPendingPaymentRows(
                        body.order_id,
                        'Superseded by Sales Receipt — payment embedded in SR'
                    )
                    if (cancelled > 0) {
                        console.log(`[invoice] Skipped ${cancelled} stale payment pipeline rows for order ${body.order_id}`)
                    }
                } catch (clErr: any) {
                    console.warn(`[invoice] Could not skip stale payment rows: ${clErr.message}`)
                }

                await writePipelineRow({
                    orderId: body.order_id,
                    referenceId: (invoice as any).id,
                    referenceType: "pos_invoice",
                    step: "sales_receipt",
                    status: "waiting",
                    medusaRefNumber: `INV-${invoice_number}`,
                })
            } else {
                // ── Invoice flow ──────────────────────────────────────────────
                // 1. Invoice row — waiting. No SO dependency (independent QB doc).
                const invoicePipelineRowId = await writePipelineRow({
                    orderId: body.order_id,
                    referenceId: (invoice as any).id,
                    referenceType: "pos_invoice",
                    step: "invoice",
                    status: "waiting",
                    medusaRefNumber: `INV-${invoice_number}`,
                })

                // 2. Payment row — waiting (only for non-credit new payments)
                if (paymentIdToEmit) {
                    await writePipelineRow({
                        orderId: body.order_id,
                        referenceId: paymentIdToEmit,
                        referenceType: "customer_payment",
                        step: "payment",
                        status: "waiting",
                        medusaRefNumber: nextPayNum ? `PAY-${nextPayNum}` : null,
                    })
                }

                // 3. Apply-payment row — one per application, each depends on invoice
                for (const app of applicationsToEmit) {
                    const applyPayRef = app.payment_id
                    // Use nextPayNum only for the newly-created payment; look up others
                    let applyMedusaRef: string | null =
                        (paymentIdToEmit && app.payment_id === paymentIdToEmit && nextPayNum)
                            ? `PAY-${nextPayNum}`
                            : null
                    if (!applyMedusaRef && applyPayRef) {
                        try {
                            const payRes = await pgConnection.raw(
                                `SELECT display_id FROM customer_payment WHERE id = ?`,
                                [applyPayRef]
                            )
                            if (payRes.rows[0]?.display_id) applyMedusaRef = `PAY-${payRes.rows[0].display_id}`
                        } catch {}
                    }
                    await writePipelineRow({
                        orderId: body.order_id,
                        referenceId: applyPayRef,
                        referenceType: "customer_payment",
                        step: "apply_payment",
                        status: "waiting",
                        dependsOn: invoicePipelineRowId,
                        medusaRefNumber: applyMedusaRef,
                    })
                }
            }
            // Skip the Sales Order pipeline row for this order — a full invoice/sales receipt
            // supersedes the need for a QB Sales Order. Do this immediately so the cron never
            // picks up the order for SO creation.
            try {
                await skipSalesOrderPipelineRow(body.order_id)
            } catch (skipErr: any) {
                console.warn("Could not skip SO pipeline row:", skipErr.message)
            }
        } catch (upfrontErr: any) {
            console.error("Failed to write upfront pipeline rows:", upfrontErr.message)
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

            // 1. Process Order Document (Invoice or Sales Receipt)
            if (body.is_sales_receipt) {
                console.log(`DIRECT EXEC: Triggering pos.sales_receipt.created directly for order ${body.order_id}.`)
                await handleSalesReceiptCreated({
                    order_id: body.order_id,
                    invoice_id: (invoice as any).id,
                    items: body.items,
                    fulfillment_id: body.fulfillment_id,
                    payment_method: body.payment_method,
                    payment_id: paymentIdToEmit
                }, orderModule, customerModule, container, logger)
            } else {
                console.log(`DIRECT EXEC: Triggering pos.invoice.created directly for order ${body.order_id} to bypass BullMQ drops.`)
                await handleFulfillmentCreated({
                    order_id: body.order_id,
                    invoice_id: (invoice as any).id,
                    items: body.items,
                    fulfillment_id: body.fulfillment_id
                }, orderModule, customerModule, container, logger)
            }

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

            // 3. Process Applications — run in parallel so multiple payments don't
            //    block each other (each may poll the bridge for up to 400s).
            if (applicationsToEmit.length > 0) {
                if (body.is_sales_receipt) {
                    console.log("DIRECT EXEC: Skipping pos.payment.applied emit because this is a Sales Receipt.")
                } else {
                    await Promise.all(applicationsToEmit.map(async (appPayload) => {
                        await handlePosPaymentApplied({
                            event: { name: "pos.payment.applied", data: appPayload },
                            container
                        } as any)
                        console.log(`DIRECT EXEC: pos.payment.applied executed for Payment ${appPayload.payment_id}!`)
                    }))
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
