import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Client } from "pg"
import { bridgeFetch, POLL_INTERVAL_MS, MAX_POLL_ATTEMPTS } from "../../../../../lib/quickbooks/client/core"
import { FINANCE_MODULE } from "../../../../../modules/finance"

/**
 * POST /admin/quickbooks/import/payments
 *
 * Fetches unapplied ReceivePayment records from QuickBooks and imports
 * them as customer_payment records with qb.status='yes'.
 *
 * Matching: QB CustomerRef.ListID → Medusa customer.metadata->>'qb_list_id'
 * Unmatched customers are skipped and reported.
 *
 * Returns:
 *   { success, imported, skipped, errors[], total }
 */
export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const client = new Client({ connectionString: process.env.DATABASE_URL })

    try {
        await client.connect()

        // ── Step 1: Queue ReceivePaymentQuery on the QB bridge ────────────────
        const qbxml = [
            `<?xml version="1.0" encoding="utf-8"?>`,
            `<?qbxml version="10.0"?>`,
            `<QBXML><QBXMLMsgsRq onError="stopOnError">`,
            `<ReceivePaymentQueryRq requestID="1">`,
            `<MaxReturned>500</MaxReturned>`,
            `</ReceivePaymentQueryRq>`,
            `</QBXMLMsgsRq></QBXML>`,
        ].join("")

        const enqueueRes = await bridgeFetch("POST", "/api/sync/direct-query", { qbxml })
        const operationId: string = enqueueRes?.operationId || enqueueRes?.operation_id
        if (!operationId) throw new Error("Bridge did not return operationId for PaymentQuery")

        // ── Step 2: Poll for the result ────────────────────────────────────────
        let rawResult: any = null
        for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
            const statusRes = await bridgeFetch("GET", `/api/sync/status/${operationId}`)
            const op = statusRes?.operation
            if (!op) continue
            if (op.status === "completed") {
                rawResult = op.result
                break
            }
            if (op.status === "failed") {
                throw new Error(`QB payment query failed: ${op.error || "Unknown error"}`)
            }
        }

        if (!rawResult) {
            throw new Error("QB payment query timed out — QB Web Connector may not be running")
        }

        // ── Step 3: Parse ReceivePaymentRet (single or array) ─────────────────
        const qbMsgs =
            rawResult?.QBXML?.QBXMLMsgsRs ||
            rawResult?.QBXMLMsgsRs ||
            rawResult

        const payRetRaw =
            qbMsgs?.ReceivePaymentQueryRs?.ReceivePaymentRet ??
            rawResult?.ReceivePaymentQueryRs?.ReceivePaymentRet ??
            rawResult?.ReceivePaymentRet

        if (!payRetRaw) {
            res.json({ success: true, imported: 0, skipped: 0, errors: [], total: 0 })
            return
        }

        const payList: any[] = Array.isArray(payRetRaw) ? payRetRaw : [payRetRaw]

        // ── Step 4: Filter unapplied (UnusedPayment > 0) ──────────────────────
        const unapplied = payList.filter(p => {
            const unused = parseFloat(p.UnusedPayment || "0")
            return unused > 0
        })

        // ── Step 5: Build customer lookup map (QB ListID → Medusa customer_id) ─
        const qbListIds = [...new Set(unapplied
            .map(p => p.CustomerRef?.ListID)
            .filter(Boolean)
        )]

        const customerMap = new Map<string, string>()
        if (qbListIds.length > 0) {
            const placeholders = qbListIds.map((_, i) => `$${i + 1}`).join(", ")
            const custResult = await client.query(`
                SELECT id, metadata->>'qb_list_id' AS qb_list_id
                FROM customer
                WHERE metadata->>'qb_list_id' IN (${placeholders})
            `, qbListIds)
            for (const row of custResult.rows) {
                if (row.qb_list_id) customerMap.set(row.qb_list_id, row.id)
            }
        }

        // ── Step 6: Import each unapplied payment via finance service ─────────
        const financeService = req.scope.resolve(FINANCE_MODULE)
        let imported = 0
        const skippedList: string[] = []
        const errors: string[] = []

        for (const pay of unapplied) {
            const txnId: string = pay.TxnID || ""
            if (!txnId) continue

            const qbListId: string = pay.CustomerRef?.ListID || ""
            const customerName: string = pay.CustomerRef?.FullName || "Unknown"
            const medusaCustomerId = customerMap.get(qbListId)

            if (!medusaCustomerId) {
                skippedList.push(`${customerName} (no Medusa match)`)
                continue
            }

            // Deduplication: skip if already imported
            const existing = await client.query(`
                SELECT id FROM customer_payment
                WHERE (qb->>'txn_id') = $1 AND deleted_at IS NULL
                LIMIT 1
            `, [txnId])
            if (existing.rows.length > 0) continue

            const unusedCents = Math.round(parseFloat(pay.UnusedPayment || "0") * 100)
            const totalCents = Math.round(parseFloat(pay.TotalAmount || "0") * 100)
            const txnDate: string = pay.TxnDate || new Date().toISOString().slice(0, 10)
            const refNumber: string = pay.RefNumber || ""

            // Map QB payment method to our enum
            const methodName: string = (pay.PaymentMethodRef?.FullName || "").toLowerCase()
            let method: "cash" | "check" | "card" | "ach" | "zelle" | "other" = "other"
            if (methodName.includes("check")) method = "check"
            else if (methodName.includes("cash")) method = "cash"
            else if (methodName.includes("ach") || methodName.includes("transfer")) method = "ach"
            else if (methodName.includes("visa") || methodName.includes("master") || methodName.includes("card")) method = "card"
            else if (methodName.includes("zelle")) method = "zelle"

            try {
                const payment = await financeService.createCustomerPayments({
                    customer_id: medusaCustomerId,
                    amount: unusedCents,
                    method,
                    reference: refNumber || null,
                    notes: "Legacy QB import",
                    received_at: new Date(txnDate),
                    created_by: "system",
                    source: "pos",
                    type: "payment",
                    status: "available",
                    metadata: {
                        qb_import: true,
                        qb_txn_id: txnId,
                        qb_total_amount_cents: totalCents,
                    },
                })

                // Set qb.status='yes' via direct SQL (not exposed as a createCustomerPayments field)
                await client.query(`
                    UPDATE customer_payment
                    SET qb = $1::jsonb
                    WHERE id = $2
                `, [JSON.stringify({ status: "yes", txn_id: txnId }), payment.id])

                imported++
            } catch (err: any) {
                errors.push(`${customerName}: ${err.message}`)
            }
        }

        res.json({
            success: true,
            imported,
            skipped: skippedList.length,
            skipped_details: skippedList.slice(0, 20),
            errors: errors.slice(0, 10),
            total: unapplied.length,
        })

    } catch (error: any) {
        console.error("[QB Import Payments] Error:", error)
        res.status(500).json({ error: error.message || "Failed to import payments" })
    } finally {
        await client.end()
    }
}
