import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules } from '@medusajs/utils'
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
    const eventBus = req.scope.resolve(Modules.EVENT_BUS)
    const { customer_id, amount, method, reference, notes, received_at, created_by, source, type, metadata } = req.body as any

    if (!customer_id) {
        return res.status(400).json({ error: 'customer_id is required' })
    }
    if (amount === undefined || amount < 0) {
        return res.status(400).json({ error: 'amount must be a non-negative number (cents)' })
    }

    // Map POS specific methods to valid backend schema enums:
    // ['cash', 'check', 'card', 'ach', 'zelle', 'credit_memo', 'stripe', 'authorize_net', 'other']
    let mappedMethod = 'other'
    const m = (method || '').toLowerCase()
    
    if (m === 'cash' || m === 'check' || m === 'zelle' || m === 'credit_memo') {
        mappedMethod = m
    } else if (['visa', 'mastercard', 'discover', 'amex', 'capital_one', 'debit_card', 'card'].includes(m)) {
        mappedMethod = 'card'
    } else if (['ach', 'checking_account', 'e_check', 'transfer', 'wire_transfer'].includes(m)) {
        mappedMethod = 'ach'
    }

    try {
        const payment = await financeService.createCustomerPayments({
            customer_id,
            amount,
            method: mappedMethod as any,
            reference: reference || null,
            notes: notes || null,
            received_at: received_at ? new Date(received_at) : new Date(),
            created_by: created_by || null,
            source: source || 'pos',
            type: type || 'payment',
            metadata: {
                ...(metadata || {}),
                pos_payment_method: m, // exact original method for QB
            },
            status: 'available' // A new manual payment is always available until applied
        })
        
        // Emit event for QuickBooks syncing
        await eventBus.emit({
            name: "pos.payment.created",
            data: { id: payment.id }
        })
        
        return res.json({ payment })
    } catch (err: any) {
        return res.status(500).json({ error: err.message })
    }
}
