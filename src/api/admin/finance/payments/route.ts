import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { FINANCE_MODULE } from '../../../../modules/finance'
import { writePipelineRow } from '../../../../lib/quickbooks/qb-pipeline'
import { handlePosPaymentCreated } from '../../../../lib/quickbooks/handlers/handle-pos-payment-created'
import { Client } from 'pg'

/**
 * GET /admin/finance/payments
 * Lists customer payments. Supports filtering by customer_id and status.
 * Applications are enriched with invoice_number from pos_invoice.
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

        // Collect all invoice_ids from applications that don't have invoice_number
        const invoiceIds = new Set<string>()
        for (const pay of payments) {
            for (const app of (pay.applications ?? [])) {
                if (app.invoice_id && !app.invoice_number) {
                    invoiceIds.add(app.invoice_id)
                }
            }
        }

        // Bulk-lookup invoice numbers from pos_invoice
        const invoiceNumberMap: Record<string, string> = {}
        if (invoiceIds.size > 0) {
            const client = new Client({ connectionString: process.env.DATABASE_URL })
            try {
                await client.connect()
                const result = await client.query<{ id: string; invoice_number: string }>(
                    `SELECT id, invoice_number FROM pos_invoice WHERE id = ANY($1)`,
                    [Array.from(invoiceIds)]
                )
                for (const row of result.rows) {
                    invoiceNumberMap[row.id] = row.invoice_number
                }
            } finally {
                await client.end()
            }
        }

        // Enrich applications with invoice_number
        const enriched = payments.map((pay: any) => ({
            ...pay,
            applications: (pay.applications ?? []).map((app: any) => ({
                ...app,
                invoice_number: app.invoice_number || (app.invoice_id ? invoiceNumberMap[app.invoice_id] : null) || null,
            })),
        }))

        return res.json({ payments: enriched })
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
        const pgConnection = req.scope.resolve("__pg_connection__") as any

        // Sequential payment number
        const seqRes = await pgConnection.raw(`SELECT nextval('custom_payment_seq') AS seq`).catch(() => ({ rows: [{ seq: null }] }))
        const nextPayNum = seqRes.rows[0]?.seq || seqRes.rows[0]?.SEQ ? Number(seqRes.rows[0].seq || seqRes.rows[0].SEQ) : null

        // Sequential transaction number — assign once per unique transaction_id
        let transactionNumber: number | null = null
        const incomingTxnId = (metadata as any)?.transaction_id
        if (incomingTxnId) {
            // Look for an existing payment in this transaction that already has a number
            const existing = await financeService.listCustomerPayments(
                { metadata: { transaction_id: incomingTxnId } } as any,
                { take: 1 }
            ).catch(() => [])
            const existingNum = (existing[0] as any)?.metadata?.transaction_number
            if (existingNum) {
                transactionNumber = Number(existingNum)
            } else {
                const txnSeqRes = await pgConnection.raw(`SELECT nextval('pos_transaction_seq') AS seq`).catch(() => ({ rows: [{ seq: null }] }))
                const raw = txnSeqRes.rows[0]?.seq ?? txnSeqRes.rows[0]?.SEQ
                if (raw) transactionNumber = Number(raw)
            }
        }

        const qbFlowEnabled = process.env.QB_ORDER_FLOW_ENABLED === "true"

        const payment = await financeService.createCustomerPayments({
            customer_id,
            display_id: nextPayNum,
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
                ...(transactionNumber !== null ? { transaction_number: transactionNumber } : {}),
                // Show spinner immediately in the UI — the QB handler will update to 'synced'/'error'
                ...(qbFlowEnabled ? { qb_sync_status: 'pending' } : {}),
            },
            status: 'available' // A new manual payment is always available until applied
        })
        
        // Write upfront pipeline row + direct exec (bypasses BullMQ outbox)
        if (process.env.QB_ORDER_FLOW_ENABLED === "true") {
            const orderId: string | null = (metadata as any)?.order_id ?? null
            try {
                await writePipelineRow({
                    orderId,
                    referenceId: payment.id,
                    referenceType: "customer_payment",
                    step: "payment",
                    status: "waiting",
                    medusaRefNumber: nextPayNum ? `PAY-${nextPayNum}` : null,
                })
            } catch (rowErr: any) {
                console.warn(`[finance/payments] Could not write upfront pipeline row: ${rowErr.message}`)
            }

            setTimeout(async () => {
                try {
                    await handlePosPaymentCreated({
                        event: { name: "pos.payment.created", data: { id: payment.id } },
                        container: req.scope as any,
                        pluginOptions: {},
                    })
                } catch (execErr: any) {
                    console.error(`[finance/payments] Direct exec pos.payment.created failed: ${execErr.message}`)
                }
            }, 100)
        }

        return res.json({ payment })
    } catch (err: any) {
        return res.status(500).json({ error: err.message })
    }
}
