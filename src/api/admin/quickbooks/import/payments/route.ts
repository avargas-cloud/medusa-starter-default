import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Client } from "pg"
import { bridgeFetch, POLL_INTERVAL_MS, MAX_POLL_ATTEMPTS } from "../../../../../lib/quickbooks/client/core"
import { FINANCE_MODULE } from "../../../../../modules/finance"

export interface PaymentPreviewRecord {
    txn_id: string
    ref_number: string
    qb_customer_name: string
    qb_list_id: string
    medusa_customer_id: string | null
    medusa_customer_email: string | null
    amount_cents: number
    date: string
    method: string
    already_imported: boolean
}

/**
 * Shared helper: fetch unapplied payments from QB and build preview records.
 */
async function fetchPaymentPreviews(client: Client): Promise<PaymentPreviewRecord[]> {
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

    let rawResult: any = null
    for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
        const statusRes = await bridgeFetch("GET", `/api/sync/status/${operationId}`)
        const op = statusRes?.operation
        if (!op) continue
        if (op.status === "completed") { rawResult = op.result; break }
        if (op.status === "failed") throw new Error(`QB payment query failed: ${op.error || "Unknown error"}`)
    }

    if (!rawResult) throw new Error("QB payment query timed out — QB Web Connector may not be running")

    const qbMsgs = rawResult?.QBXML?.QBXMLMsgsRs || rawResult?.QBXMLMsgsRs || rawResult
    const payRetRaw =
        qbMsgs?.ReceivePaymentQueryRs?.ReceivePaymentRet ??
        rawResult?.ReceivePaymentQueryRs?.ReceivePaymentRet ??
        rawResult?.ReceivePaymentRet

    if (!payRetRaw) return []

    const payList: any[] = Array.isArray(payRetRaw) ? payRetRaw : [payRetRaw]
    const unapplied = payList.filter(p => parseFloat(p.UnusedPayment || "0") > 0)

    // Build customer lookup map
    const qbListIds = [...new Set(unapplied.map(p => p.CustomerRef?.ListID).filter(Boolean))]
    const customerMap = new Map<string, { id: string; email: string | null }>()
    if (qbListIds.length > 0) {
        const placeholders = qbListIds.map((_, i) => `$${i + 1}`).join(", ")
        const custResult = await client.query(`
            SELECT id, email, metadata->>'qb_list_id' AS qb_list_id
            FROM customer
            WHERE metadata->>'qb_list_id' IN (${placeholders})
        `, qbListIds)
        for (const row of custResult.rows) {
            if (row.qb_list_id) customerMap.set(row.qb_list_id, { id: row.id, email: row.email ?? null })
        }
    }

    // Check which TxnIDs are already imported
    const allTxnIds = unapplied.map(p => p.TxnID).filter(Boolean)
    const importedSet = new Set<string>()
    if (allTxnIds.length > 0) {
        const placeholders = allTxnIds.map((_, i) => `$${i + 1}`).join(", ")
        const existingRes = await client.query(`
            SELECT qb->>'txn_id' AS txn_id FROM customer_payment
            WHERE qb->>'txn_id' IN (${placeholders}) AND deleted_at IS NULL
        `, allTxnIds)
        for (const row of existingRes.rows) {
            if (row.txn_id) importedSet.add(row.txn_id)
        }
    }

    return unapplied.map(pay => {
        const qbListId: string = pay.CustomerRef?.ListID || ""
        const match = customerMap.get(qbListId) ?? null
        const methodName = (pay.PaymentMethodRef?.FullName || "").toLowerCase()
        let method = "other"
        if (methodName.includes("check")) method = "check"
        else if (methodName.includes("cash")) method = "cash"
        else if (methodName.includes("ach") || methodName.includes("transfer")) method = "ach"
        else if (methodName.includes("visa") || methodName.includes("master") || methodName.includes("card")) method = "card"
        else if (methodName.includes("zelle")) method = "zelle"

        return {
            txn_id: pay.TxnID || "",
            ref_number: pay.RefNumber || "",
            qb_customer_name: pay.CustomerRef?.FullName || "Unknown",
            qb_list_id: qbListId,
            medusa_customer_id: match?.id ?? null,
            medusa_customer_email: match?.email ?? null,
            amount_cents: Math.round(parseFloat(pay.UnusedPayment || "0") * 100),
            date: pay.TxnDate || "",
            method,
            already_imported: importedSet.has(pay.TxnID || ""),
        }
    })
}

/**
 * GET /admin/quickbooks/import/payments
 *
 * Preview-only: fetches unapplied payments from QB and returns them
 * with match status. Does NOT write anything to the database.
 */
export async function GET(
    _req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    try {
        await client.connect()
        const records = await fetchPaymentPreviews(client)
        const matched = records.filter(r => r.medusa_customer_id && !r.already_imported).length
        const unmatched = records.filter(r => !r.medusa_customer_id).length
        const already = records.filter(r => r.already_imported).length
        res.json({ success: true, records, total: records.length, matched, unmatched, already_imported: already })
    } catch (error: any) {
        console.error("[QB Preview Payments] Error:", error)
        res.status(500).json({ error: error.message || "Failed to preview payments" })
    } finally {
        await client.end()
    }
}

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

        const previews = await fetchPaymentPreviews(client)
        const toImport = previews.filter(p => p.medusa_customer_id && !p.already_imported)

        if (toImport.length === 0) {
            res.json({ success: true, imported: 0, skipped: previews.filter(p => !p.medusa_customer_id).length, errors: [], total: previews.length })
            return
        }

        const financeService = req.scope.resolve(FINANCE_MODULE)
        let imported = 0
        const errors: string[] = []

        for (const pay of toImport) {
            try {
                const payment = await financeService.createCustomerPayments({
                    customer_id: pay.medusa_customer_id!,
                    amount: pay.amount_cents,
                    method: pay.method as "cash" | "check" | "card" | "ach" | "zelle" | "other",
                    reference: pay.ref_number || null,
                    notes: "Legacy QB import",
                    received_at: new Date(pay.date),
                    created_by: "system",
                    source: "pos",
                    type: "payment",
                    status: "available",
                    metadata: { qb_import: true, qb_txn_id: pay.txn_id },
                })

                await client.query(
                    `UPDATE customer_payment SET qb = $1::jsonb WHERE id = $2`,
                    [JSON.stringify({ status: "yes", txn_id: pay.txn_id }), payment.id]
                )
                imported++
            } catch (err: any) {
                errors.push(`${pay.qb_customer_name}: ${err.message}`)
            }
        }

        const skipped = previews.filter(p => !p.medusa_customer_id).length
        res.json({
            success: true,
            imported,
            skipped,
            skipped_details: previews.filter(p => !p.medusa_customer_id).map(p => `${p.qb_customer_name} (no Medusa match)`).slice(0, 20),
            errors: errors.slice(0, 10),
            total: previews.length,
        })

    } catch (error: any) {
        console.error("[QB Import Payments] Error:", error)
        res.status(500).json({ error: error.message || "Failed to import payments" })
    } finally {
        await client.end()
    }
}
