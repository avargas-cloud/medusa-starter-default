import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { FINANCE_MODULE } from '../../../../modules/finance'

/**
 * GET /admin/finance/payments
 * Lists customer payments. Supports filtering by customer_id and status.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
    const financeService = req.scope.resolve(FINANCE_MODULE)
    const { customer_id, status } = req.query as { customer_id?: string, status?: string }

    const filters: any = {}
    if (customer_id) filters.customer_id = customer_id
    if (status) filters.status = status

    try {
        const payments = await financeService.listCustomerPayments(filters, {
            order: { received_at: 'DESC' },
            relations: ['applications']
        })
        return res.json({ payments })
    } catch (err: any) {
        return res.status(500).json({ error: err.message })
    }
}

/**
 * POST /admin/finance/payments
 * Creates a new customer payment (e.g. a deposit or independent payment).
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
    const financeService = req.scope.resolve(FINANCE_MODULE)
    const { customer_id, amount, method, reference, notes, received_at, created_by, source, type } = req.body as any

    if (!customer_id) {
        return res.status(400).json({ error: 'customer_id is required' })
    }
    if (amount === undefined || amount <= 0) {
        return res.status(400).json({ error: 'amount must be a positive number (cents)' })
    }

    try {
        const payment = await financeService.createCustomerPayments({
            customer_id,
            amount,
            method: method || 'other',
            reference: reference || null,
            notes: notes || null,
            received_at: received_at ? new Date(received_at) : new Date(),
            created_by: created_by || null,
            source: source || 'pos',
            type: type || 'payment',
            status: 'available' // A new manual payment is always available until applied
        })
        
        return res.json({ payment })
    } catch (err: any) {
        return res.status(500).json({ error: err.message })
    }
}
