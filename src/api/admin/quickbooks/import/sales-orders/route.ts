import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Client } from "pg"
import { bridgeFetch, POLL_INTERVAL_MS, MAX_POLL_ATTEMPTS } from "../../../../../lib/quickbooks/client/core"

/**
 * POST /admin/quickbooks/import/sales-orders
 *
 * Body: { refNumber: string }
 *
 * Queries QB for a single Sales Order by RefNumber, upserts into qb_legacy_so.
 * Returns: { success, record }
 */
export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const { refNumber } = (req.body ?? {}) as { refNumber?: string }
    if (!refNumber?.trim()) {
        res.status(400).json({ error: "refNumber is required" })
        return
    }

    const client = new Client({ connectionString: process.env.DATABASE_URL })
    try {
        await client.connect()

        const qbxml = [
            `<?xml version="1.0" encoding="utf-8"?>`,
            `<?qbxml version="10.0"?>`,
            `<QBXML><QBXMLMsgsRq onError="stopOnError">`,
            `<SalesOrderQueryRq requestID="1">`,
            `<RefNumber>${refNumber.trim()}</RefNumber>`,
            `</SalesOrderQueryRq>`,
            `</QBXMLMsgsRq></QBXML>`,
        ].join("")

        const enqueueRes = await bridgeFetch("POST", "/api/sync/direct-query", { qbxml })
        const operationId: string = enqueueRes?.operationId || enqueueRes?.operation_id
        if (!operationId) throw new Error("Bridge did not return operationId")

        let rawResult: any = null
        for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
            const statusRes = await bridgeFetch("GET", `/api/sync/status/${operationId}`)
            const op = statusRes?.operation
            if (!op) continue
            if (op.status === "completed") { rawResult = op.result; break }
            if (op.status === "failed") throw new Error(`QB query failed: ${op.error || "Unknown error"}`)
        }

        if (!rawResult) throw new Error("QB query timed out — QB Web Connector may not be running")

        const qbMsgs = rawResult?.QBXML?.QBXMLMsgsRs || rawResult?.QBXMLMsgsRs || rawResult
        const soRetRaw =
            qbMsgs?.SalesOrderQueryRs?.SalesOrderRet ??
            rawResult?.SalesOrderQueryRs?.SalesOrderRet ??
            rawResult?.SalesOrderRet

        if (!soRetRaw) {
            res.status(404).json({ error: `Sales Order #${refNumber} not found in QuickBooks` })
            return
        }

        const so = Array.isArray(soRetRaw) ? soRetRaw[0] : soRetRaw
        const txnId: string = so.TxnID || ""
        if (!txnId) {
            res.status(404).json({ error: `Sales Order #${refNumber} returned no TxnID` })
            return
        }

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
        `, [txnId, refNumber.trim(), customerListId, customerName, txnDate || null, amount, balance])

        res.json({
            success: true,
            record: { txnId, refNumber: refNumber.trim(), customer: customerName, date: txnDate, amount, balance },
        })

    } catch (error: any) {
        console.error(`[QB Import SO #${refNumber}] Error:`, error)
        res.status(500).json({ error: error.message || "Failed to import Sales Order" })
    } finally {
        await client.end()
    }
}

/**
 * GET /admin/quickbooks/import/sales-orders
 * Returns stored qb_legacy_so records.
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
            ORDER BY qb_ref_number::int DESC
        `)
        res.json({ records: result.rows, total: result.rowCount ?? 0 })
    } catch (error: any) {
        console.error("[QB Import SOs GET] Error:", error)
        res.status(500).json({ error: error.message || "Failed to fetch legacy SOs" })
    } finally {
        await client.end()
    }
}
