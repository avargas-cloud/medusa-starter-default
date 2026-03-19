/**
 * src/api/admin/invoices/[id]/void/route.ts
 * POST /admin/invoices/:id/void — Void an issued invoice
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { INVOICE_MODULE } from '../../../../../modules/invoices'
import { FINANCE_MODULE } from '../../../../../modules/finance'

export async function POST(req: MedusaRequest, res: MedusaResponse) {
    const invoiceService = req.scope.resolve(INVOICE_MODULE)
    const financeService = req.scope.resolve(FINANCE_MODULE)
    const id = req.params.id!
    const { void_reason } = req.body as { void_reason?: string }

    let invoice: any
    try {
        invoice = await invoiceService.retrievePosInvoice(id)
    } catch {
        return res.status(404).json({ error: 'Invoice not found' })
    }

    if (invoice.status === 'voided') {
        return res.status(409).json({ error: 'Invoice is already voided' })
    }

    // 1. UNAPPLY ALL ATTACHED PAYMENTS FIRST (Free up customer balance)
    const dbApplications = await financeService.listPaymentApplications({ invoice_id: id }, {
        relations: ['payment']
    })
    
    // Only process applications that aren't already voided
    const activeApplications = dbApplications.filter((app: any) => !app.voided_at)

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
    }

    // 2. MARK INVOICE AS VOIDED & BALANCE TO 0
    const finalInvoicePayments = await invoiceService.listInvoicePayments({ invoice_id: id })
    const finalTotalPaid = finalInvoicePayments.reduce((sum: number, p: any) => sum + Number(p.amount), 0)

    const updated = await invoiceService.updatePosInvoices(
        { id },
        {
            amount_paid: finalTotalPaid,
            balance_due: 0, // Voided means balance is zeroed out
            status:     'voided' as const,
            voided_at:  new Date(),
            void_reason: void_reason ?? null,
        }
    )

    return res.json({ invoice: updated, total_reversed: totalReversed })
}
