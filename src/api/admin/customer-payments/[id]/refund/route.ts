/**
 * POST /admin/customer-payments/:id/refund
 * Void or partially refund a payment.
 * Body: { amount?: number, notes?: string, voided_by?: string }
 * If amount not provided or equals full amount → full void (status: voided)
 * If partial → creates a negative CustomerPayment of type 'refund'
 */
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { FINANCE_MODULE } from '../../../../../modules/finance'

export async function POST(req: MedusaRequest, res: MedusaResponse) {
    const id = req.params.id!
    const { amount, notes, voided_by } = req.body as any

    const financeService = req.scope.resolve(FINANCE_MODULE)

    try {
        const payment = await financeService.retrieveCustomerPayment(id, { relations: ['applications'] })
        if (!payment) return res.status(404).json({ error: 'Payment not found' })
        if (payment.status === 'voided') return res.status(400).json({ error: 'Payment is already voided' })

        const activeApps: any[] = (payment.applications ?? []).filter((a: any) => !a.voided_at)
        const alreadyApplied = activeApps.reduce((s: number, a: any) => s + Number(a.amount_applied ?? 0), 0)
        const available = Math.max(0, Number(payment.amount) - alreadyApplied)

        const refundAmount = amount ?? available

        if (refundAmount <= 0) return res.status(400).json({ error: 'No available balance to refund' })
        if (refundAmount > available) {
            return res.status(400).json({ error: `Refund amount (${refundAmount}) exceeds available balance (${available})` })
        }

        const now = new Date()
        const isFullVoid = refundAmount >= available

        if (isFullVoid) {
            // Full void
            await financeService.updateCustomerPayments(
                { id },
                { status: 'voided', notes: notes ?? payment.notes }
            )
        } else {
            const pgConnection = req.scope.resolve("__pg_connection__") as any
            const seqPgRes = await pgConnection.raw(`SELECT nextval('custom_payment_seq') AS seq`).catch(() => ({ rows: [{ seq: null }] }))
            const nextPayNum = seqPgRes.rows[0]?.seq || seqPgRes.rows[0]?.SEQ ? Number(seqPgRes.rows[0].seq || seqPgRes.rows[0].SEQ) : null

            // Partial refund — create a negative CustomerPayment of type 'refund'
            await financeService.createCustomerPayments({
                customer_id: payment.customer_id,
                display_id: nextPayNum,
                amount: refundAmount,
                method: payment.method,
                reference: payment.reference ?? null,
                notes: notes ?? `Partial refund of ${id}`,
                received_at: now,
                created_by: voided_by ?? null,
                source: 'pos',
                type: 'refund',
                status: 'applied',
                medusa_payment_synced: false,
            })
        }

        const updated = await financeService.retrieveCustomerPayment(id, { relations: ['applications'] })
        return res.json({ payment: updated, refunded: refundAmount, full_void: isFullVoid })
    } catch (err: any) {
        return res.status(500).json({ error: err.message })
    }
}
