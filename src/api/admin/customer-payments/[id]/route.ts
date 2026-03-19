/**
 * GET /admin/customer-payments/:id — get a single payment with applications + customer
 */
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules } from '@medusajs/utils'
import { FINANCE_MODULE } from '../../../../modules/finance'
import { INVOICE_MODULE } from '../../../../modules/invoices'

export async function GET(req: MedusaRequest, res: MedusaResponse) {
    const id = req.params.id!
    const financeService = req.scope.resolve(FINANCE_MODULE)
    const invoiceService = req.scope.resolve(INVOICE_MODULE)
    const customerModule = req.scope.resolve(Modules.CUSTOMER)

    try {
        const payment = await financeService.retrieveCustomerPayment(id, {
            relations: ['applications'],
        })
        if (!payment) return res.status(404).json({ error: 'Payment not found' })

        // Enrich with customer
        let customer = null
        try {
            const [cust] = await customerModule.listCustomers(
                { id: [payment.customer_id] },
                { select: ['id', 'first_name', 'last_name', 'email', 'phone', 'company_name'] }
            )
            customer = cust ?? null
        } catch { /* non-fatal */ }

        // Enrich applications with invoice numbers
        const applications: any[] = payment.applications ?? []
        const invoiceIds = [...new Set(applications.map((a: any) => a.invoice_id).filter(Boolean))]
        let invoiceMap: Record<string, any> = {}
        if (invoiceIds.length) {
            try {
                const invoices = await invoiceService.listPosInvoices({ id: invoiceIds })
                invoices.forEach((inv: any) => { invoiceMap[inv.id] = inv })
            } catch { /* non-fatal */ }
        }

        const enrichedApps = applications.map((a: any) => ({
            ...a,
            invoice: a.invoice_id ? invoiceMap[a.invoice_id] ?? null : null,
        }))

        // Compute balances
        const activeApps = enrichedApps.filter((a: any) => !a.voided_at)
        const amountApplied = activeApps.reduce((s: number, a: any) => s + Number(a.amount_applied ?? 0), 0)
        const availableBalance = Math.max(0, Number(payment.amount) - amountApplied)

        return res.json({
            payment: {
                ...payment,
                applications: enrichedApps,
                customer,
                amount_applied: amountApplied,
                available_balance: availableBalance,
            }
        })
    } catch (err: any) {
        return res.status(500).json({ error: err.message })
    }
}
