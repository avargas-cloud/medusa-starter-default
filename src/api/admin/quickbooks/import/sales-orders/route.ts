import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Client } from "pg"
import { bridgeFetch, POLL_INTERVAL_MS, MAX_POLL_ATTEMPTS } from "../../../../../lib/quickbooks/client/core"

/**
 * POST /admin/quickbooks/import/sales-orders
 *
 * Fetches all open (non-manually-closed) Sales Orders from QuickBooks
 * and upserts them into the qb_legacy_so reference table.
 *
 * Returns:
 *   { success, total, records[] }
 */
export async function POST(
    _req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const client = new Client({ connectionString: process.env.DATABASE_URL })

    try {
        await client.connect()

        // ── Step 1: Queue the query on the QB bridge ──────────────────────────
        const qbxml = [
            `<?xml version="1.0" encoding="utf-8"?>`,
            `<?qbxml version="10.0"?>`,
            `<QBXML><QBXMLMsgsRq onError="stopOnError">`,
            `<SalesOrderQueryRq requestID="1">`,
            `<MaxReturned>500</MaxReturned>`,
            `</SalesOrderQueryRq>`,
            `</QBXMLMsgsRq></QBXML>`,
        ].join("")

        const enqueueRes = await bridgeFetch("POST", "/api/sync/direct-query", { qbxml })
        const operationId: string = enqueueRes?.operationId || enqueueRes?.operation_id
        if (!operationId) throw new Error("Bridge did not return operationId for SalesOrderQuery")

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
                throw new Error(`QB query failed: ${op.error || "Unknown error"}`)
            }
        }

        if (!rawResult) {
            throw new Error("QB query timed out — QB Web Connector may not be running")
        }

        // ── Step 3: Parse SalesOrderRet (single or array) ─────────────────────
        const qbMsgs =
            rawResult?.QBXML?.QBXMLMsgsRs ||
            rawResult?.QBXMLMsgsRs ||
            rawResult

        const soRetRaw =
            qbMsgs?.SalesOrderQueryRs?.SalesOrderRet ??
            rawResult?.SalesOrderQueryRs?.SalesOrderRet ??
            rawResult?.SalesOrderRet

        if (!soRetRaw) {
            res.json({ success: true, total: 0, records: [] })
            return
        }

        // Filter out manually closed SOs client-side (IsManuallyClosed is not a valid QBXML query filter)
        const allSos: any[] = Array.isArray(soRetRaw) ? soRetRaw : [soRetRaw]
        // Keep only SOs from 2021 onwards — pre-2021 are legacy junk with no active balance
        // (BalanceRemaining is unreliable in QB QBXML response for SO headers without line items)
        const soList = allSos.filter(so => {
            if (so.IsManuallyClosed === "true") return false
            const txnDate: string = so.TxnDate || ""
            return txnDate >= "2021-01-01"
        })

        // ── Step 4: Upsert active SOs, delete any that no longer exist in QB ──
        const records: Array<{ txnId: string; refNumber: string; customer: string; date: string; amount: number; balance: number }> = []

        for (const so of soList) {
            const txnId: string = so.TxnID || ""
            if (!txnId) continue

            const refNumber: string = so.RefNumber || ""
            const customerListId: string = so.CustomerRef?.ListID || ""
            const customerName: string = so.CustomerRef?.FullName || ""
            const txnDate: string = so.TxnDate || ""
            const amount = parseFloat(so.Subtotal || so.TotalAmount || "0") || 0
            const balance = parseFloat(so.BalanceRemaining || "0") || 0

            await client.query(`
                INSERT INTO qb_legacy_so
                    (qb_txn_id, qb_ref_number, qb_customer_list_id, qb_customer_name,
                     txn_date, amount, balance_remaining, status, imported_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', NOW())
                ON CONFLICT (qb_txn_id) DO UPDATE
                    SET qb_ref_number       = EXCLUDED.qb_ref_number,
                        qb_customer_list_id = EXCLUDED.qb_customer_list_id,
                        qb_customer_name    = EXCLUDED.qb_customer_name,
                        txn_date            = EXCLUDED.txn_date,
                        amount              = EXCLUDED.amount,
                        balance_remaining   = EXCLUDED.balance_remaining,
                        imported_at         = NOW()
            `, [txnId, refNumber, customerListId, customerName, txnDate || null, amount, balance])

            records.push({ txnId, refNumber, customer: customerName, date: txnDate, amount, balance })
        }

        // ── Step 5: Remove DB records no longer in QB (closed/fully invoiced) ─
        let removed = 0
        if (records.length > 0) {
            const activeTxnIds = records.map(r => r.txnId)
            const placeholders = activeTxnIds.map((_, i) => `$${i + 1}`).join(", ")
            const del = await client.query(
                `DELETE FROM qb_legacy_so WHERE qb_txn_id NOT IN (${placeholders})`,
                activeTxnIds
            )
            removed = del.rowCount ?? 0
        }

        res.json({ success: true, total: records.length, removed, records })

    } catch (error: any) {
        console.error("[QB Import SOs] Error:", error)
        res.status(500).json({ error: error.message || "Failed to import Sales Orders" })
    } finally {
        await client.end()
    }
}

/**
 * GET /admin/quickbooks/import/sales-orders
 *
 * Returns the currently stored qb_legacy_so records.
 */
export async function GET(
    _req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    try {
        await client.connect()

        const tableCheck = await client.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables
                WHERE table_name = 'qb_legacy_so'
            ) AS exists
        `)
        if (!tableCheck.rows[0]?.exists) {
            res.json({ records: [], total: 0 })
            return
        }

        const result = await client.query(`
            SELECT qb_txn_id, qb_ref_number, qb_customer_list_id, qb_customer_name,
                   txn_date, amount, balance_remaining, status, imported_at
            FROM qb_legacy_so
            ORDER BY txn_date DESC, qb_ref_number DESC
        `)
        res.json({ records: result.rows, total: result.rowCount ?? 0 })
    } catch (error: any) {
        console.error("[QB Import SOs GET] Error:", error)
        res.status(500).json({ error: error.message || "Failed to fetch legacy SOs" })
    } finally {
        await client.end()
    }
}
