/**
 * src/api/admin/invoices/route.ts
 * GET  /admin/invoices       — List invoices (filter by order_id)
 * POST /admin/invoices       — Create a new invoice
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { INVOICE_MODULE } from '../../../modules/invoices'
import { FINANCE_MODULE } from '../../../modules/finance'

// ── GET /admin/invoices?order_id=:id ─────────────────────────────────────────

export async function GET(req: MedusaRequest, res: MedusaResponse) {
    const invoiceService = req.scope.resolve(INVOICE_MODULE)
    const { order_id, customer_id } = req.query as Record<string, string>

    const filters: Record<string, unknown> = {}
    if (order_id) {
        filters.order_id = order_id
    }
    if (customer_id) {
        filters.customer_id = customer_id
    }

    const invoices = await invoiceService.listPosInvoices(filters, {
        relations: ['items', 'tracking_links'],
        order: { created_at: 'DESC' },
    })

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
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
    const invoiceService = req.scope.resolve(INVOICE_MODULE)
    const financeService = req.scope.resolve(FINANCE_MODULE)
    const body = req.body as CreateInvoiceBody

    if (!body.order_id || !body.customer_id || !body.items?.length) {
        return res.status(400).json({ error: 'order_id, customer_id, and items are required' })
    }

    // Derive invoice number: INV-{display_id}-{seq}
    const existing = await invoiceService.listPosInvoices({ order_id: body.order_id })
    const seq = existing.length + 1
    const invoice_number = `INV-${body.order_display_id}-${seq}`

    const balance_due = body.total - body.amount_paid

    // Step 1: Create the invoice (no nested items — hasMany must be created separately)
    const invoice = await invoiceService.createPosInvoices({
        invoice_number,
        order_id:       body.order_id,
        fulfillment_id: body.fulfillment_id ?? null,
        customer_id:    body.customer_id,
        status:         'issued' as const,
        subtotal:       body.subtotal,
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
                        
                        await financeService.createPaymentApplications({
                            payment_id: p.id,
                            invoice_id: (invoice as any).id,
                            order_id: body.order_id,
                            amount_applied: applyAmount,
                            applied_at: paymentDate,
                            applied_by: body.created_by || null
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
            // B. Finance Module global AR Ledger integration (New Money via Cash/Card/etc)
            const customerPayment = await financeService.createCustomerPayments({
                customer_id: body.customer_id,
                amount: body.amount_paid,
                method: body.payment_method as any,
                reference: 'Deposit', // Label to clarify this was pre-paid
                notes: body.notes || 'Initial invoice payment via Complete Order',
                received_at: paymentDate,
                created_by: body.created_by || null,
                source: 'pos',
                type: 'payment',
                status: 'applied',
            })

            // C. Finance Application map
            await financeService.createPaymentApplications({
                payment_id: customerPayment.id,
                invoice_id: (invoice as any).id,
                order_id: body.order_id,
                amount_applied: body.amount_paid,
                applied_at: paymentDate,
                applied_by: body.created_by || null
            })
        }
    }

    // Re-fetch with relations for the response
    const full = await invoiceService.retrievePosInvoice((invoice as any).id, {
        relations: ['items'],
    }).catch(() => invoice)

    return res.status(201).json({ invoice: full })
}

