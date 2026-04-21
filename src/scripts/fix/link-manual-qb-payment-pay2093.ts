/**
 * link-manual-qb-payment-pay2093.ts
 *
 * One-shot recovery for PAY-2093 (Sergio Patruno / EURO DESIGN CORP).
 *
 * Context:
 *   - $716.16 debit_card payment was originally synced to QB as a Sales Receipt
 *     that was later voided (qb.txn_id 1C1119-1776699423, status "voided").
 *   - $669.31 of that payment was applied internally to invoice IN-20083
 *     (qb_txn_id 1C11B0-1776720355).
 *   - Pipeline op #311 (apply_payment) is stuck in "pending" because someone
 *     applied that $669.31 directly in QuickBooks Desktop, bypassing the bridge.
 *   - $46.85 still usable as deposit balance.
 *
 * What this script does:
 *   1. Queries QB for all ReceivePayments dated 2026-04-20 applied to invoice
 *      TxnID 1C11B0-1776720355.
 *   2. Picks the one matching ~$669.31 to EURO DESIGN CORP.
 *   3. Updates customer_payment.qb to point at the new ReceivePayment
 *      (TxnID + EditSequence + status="active") so the remaining $46.85 stays
 *      ready-to-use for future apply ops.
 *   4. Marks qb_order_pipeline row #311 as confirmed, recording the new TxnID.
 *   5. Caches the EditSequence in qb_edit_sequence_cache.
 *
 * Run:
 *   yarn tsx src/scripts/fix/link-manual-qb-payment-pay2093.ts --dry-run
 *   yarn tsx src/scripts/fix/link-manual-qb-payment-pay2093.ts
 */

import { Client } from "pg"

const QB_BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com"
const QB_API_KEY = process.env.QB_API_KEY || ""
const DATABASE_URL = process.env.DATABASE_URL!
const DRY_RUN = process.argv.includes("--dry-run")

const PAYMENT_ID = "cpay_01KPNRJEMW964Z57T18P1WE699"
const PAYMENT_DISPLAY = "PAY-2093"
const INVOICE_QB_TXN_ID = "1C11B0-1776720355"
const INVOICE_NUMBER = "20083"
const EXPECTED_PAYMENT_TOTAL = 716.16  // full deposit amount on the QB ReceivePayment
const EXPECTED_APPLIED = 669.31        // portion applied to IN-20083 (the rest stays unapplied)
const AMOUNT_TOLERANCE = 0.05
const PIPELINE_SEQ = 311
const SEARCH_DATE = "2026-04-20"

const POLL_INTERVAL_MS = 5000
const POLL_MAX_ATTEMPTS = 60

interface QbAppliedTo {
    TxnID?: string
    RefNumber?: string | null
    Amount?: string | number
}

interface QbReceivePaymentRet {
    TxnID?: string
    EditSequence?: string
    RefNumber?: string
    TxnDate?: string
    TotalAmount?: string | number
    CustomerRef?: { ListID?: string; FullName?: string }
    AppliedToTxnRet?: QbAppliedTo | QbAppliedTo[]
}

async function bridgeFetch(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${QB_BRIDGE_URL}${path}`, {
        method,
        headers: {
            "x-api-key": QB_API_KEY,
            "content-type": "application/json",
            "bypass-tunnel-reminder": "true",
        },
        body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`Bridge ${method} ${path} → ${res.status}: ${text}`)
    }
    return res.json()
}

async function pollRaw(operationId: string): Promise<any> {
    for (let i = 1; i <= POLL_MAX_ATTEMPTS; i++) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
        const status = await bridgeFetch("GET", `/api/sync/status/${operationId}`)
        const op = status?.operation
        if (!op) continue
        if (op.status === "completed") return op.result
        if (op.status === "failed") throw new Error(`op ${operationId} failed: ${op.error}`)
        console.log(`   ⏳ poll ${i}/${POLL_MAX_ATTEMPTS}: ${op.status}`)
    }
    throw new Error(`Polling timed out for op ${operationId}`)
}

function pickAppliedToArr(ret: QbReceivePaymentRet): QbAppliedTo[] {
    const a = ret.AppliedToTxnRet
    if (!a) return []
    return Array.isArray(a) ? a : [a]
}

async function searchPaymentsForInvoice(): Promise<QbReceivePaymentRet[]> {
    const qbxml = [
        `<?xml version="1.0" encoding="utf-8"?>`,
        `<?qbxml version="10.0"?>`,
        `<QBXML><QBXMLMsgsRq onError="stopOnError">`,
        `<ReceivePaymentQueryRq requestID="1">`,
        `<TxnDateRangeFilter>`,
        `<FromTxnDate>${SEARCH_DATE}</FromTxnDate>`,
        `<ToTxnDate>${SEARCH_DATE}</ToTxnDate>`,
        `</TxnDateRangeFilter>`,
        `<IncludeLineItems>true</IncludeLineItems>`,
        `</ReceivePaymentQueryRq>`,
        `</QBXMLMsgsRq></QBXML>`,
    ].join("")

    console.log(`🔎 Querying QB for ReceivePayments on ${SEARCH_DATE}…`)
    const enq = await bridgeFetch("POST", "/api/sync/direct-query", { qbxml })
    const opId: string | undefined = enq?.operationId || enq?.operation_id
    if (!opId) throw new Error("Bridge did not return operationId for query")

    const raw = await pollRaw(opId)
    const msgs = raw?.QBXML?.QBXMLMsgsRs ?? raw?.QBXMLMsgsRs ?? raw ?? {}
    const retRaw =
        msgs?.ReceivePaymentQueryRs?.ReceivePaymentRet ??
        raw?.ReceivePaymentQueryRs?.ReceivePaymentRet ??
        raw?.ReceivePaymentRet ??
        null
    if (!retRaw) {
        console.log(`   (no ReceivePayments returned)`)
        return []
    }
    return Array.isArray(retRaw) ? retRaw : [retRaw]
}

async function main(): Promise<void> {
    if (!QB_API_KEY) throw new Error("QB_API_KEY not set in env")
    if (!DATABASE_URL) throw new Error("DATABASE_URL not set in env")

    const client = new Client({
        connectionString: DATABASE_URL,
        ssl: DATABASE_URL.includes("railway") || DATABASE_URL.includes("sslmode")
            ? { rejectUnauthorized: false }
            : undefined,
    })
    await client.connect()

    try {
        // ── 0. Sanity-check current DB state ─────────────────────────────────
        const payRes = await client.query(
            `SELECT id, display_id, customer_id, amount, status, qb
             FROM customer_payment WHERE id = $1`,
            [PAYMENT_ID],
        )
        if (payRes.rows.length === 0) {
            throw new Error(`customer_payment ${PAYMENT_ID} not found`)
        }
        const payment = payRes.rows[0]
        console.log(`💰 ${PAYMENT_DISPLAY}: amount=$${(Number(payment.amount) / 100).toFixed(2)}, status=${payment.status}`)
        console.log(`   current qb metadata: ${JSON.stringify(payment.qb)}`)

        const pipeRes = await client.query(
            `SELECT seq, step, status, reference_id, depends_on, qb_txn_id, retry_count, error
             FROM qb_order_pipeline WHERE seq = $1`,
            [PIPELINE_SEQ],
        )
        if (pipeRes.rows.length === 0) {
            throw new Error(`pipeline row seq=${PIPELINE_SEQ} not found`)
        }
        const pipe = pipeRes.rows[0]
        console.log(`📋 pipeline #${pipe.seq} ${pipe.step}: status=${pipe.status}, retries=${pipe.retry_count}`)
        if (pipe.status === "confirmed") {
            console.log(`✅ Pipeline already confirmed — nothing to do.`)
            return
        }

        // ── 1. Query QB and find the matching ReceivePayment ─────────────────
        const candidates = await searchPaymentsForInvoice()
        console.log(`   Got ${candidates.length} ReceivePayment(s) on ${SEARCH_DATE}`)

        const matched = candidates.filter(rp => {
            const applied = pickAppliedToArr(rp)
            return applied.some(a => String(a?.TxnID || "") === INVOICE_QB_TXN_ID)
        })
        console.log(`   ${matched.length} payment(s) apply to invoice ${INVOICE_QB_TXN_ID} (IN-${INVOICE_NUMBER})`)

        if (matched.length === 0) {
            throw new Error(
                `No ReceivePayment in QB on ${SEARCH_DATE} applies to invoice ${INVOICE_QB_TXN_ID}. ` +
                `Was the manual payment really posted in QuickBooks?`,
            )
        }

        const winners = matched.filter(rp => {
            const total = parseFloat(String(rp.TotalAmount ?? "0"))
            const totalOk = Math.abs(total - EXPECTED_PAYMENT_TOTAL) <= AMOUNT_TOLERANCE
            const appliedRow = pickAppliedToArr(rp).find(a => String(a?.TxnID) === INVOICE_QB_TXN_ID)
            const applied = parseFloat(String(appliedRow?.Amount ?? "0"))
            const appliedOk = Math.abs(applied - EXPECTED_APPLIED) <= AMOUNT_TOLERANCE
            return totalOk && appliedOk
        })
        if (winners.length !== 1) {
            console.log(`   Candidates:`)
            matched.forEach(rp => {
                const appliedRow = pickAppliedToArr(rp).find(a => String(a?.TxnID) === INVOICE_QB_TXN_ID)
                console.log(`     - TxnID=${rp.TxnID} ref=${rp.RefNumber} total=$${rp.TotalAmount} appliedToInv=$${appliedRow?.Amount} customer=${rp.CustomerRef?.FullName}`)
            })
            throw new Error(
                `Expected exactly 1 ReceivePayment with total ~$${EXPECTED_PAYMENT_TOTAL.toFixed(2)} applying $${EXPECTED_APPLIED.toFixed(2)} to invoice ${INVOICE_QB_TXN_ID}; ` +
                `found ${winners.length}. Aborting — please disambiguate manually.`,
            )
        }

        const winner = winners[0]
        const newTxnId = String(winner.TxnID || "")
        const newEditSeq = String(winner.EditSequence || "")
        if (!newTxnId || !newEditSeq) {
            throw new Error(`QB ReceivePayment is missing TxnID or EditSequence: ${JSON.stringify(winner)}`)
        }

        const appliedToInvoice = pickAppliedToArr(winner).find(a => String(a?.TxnID) === INVOICE_QB_TXN_ID)
        const appliedAmount = parseFloat(String(appliedToInvoice?.Amount ?? "0"))

        console.log(`\n🎯 Matched ReceivePayment:`)
        console.log(`   TxnID:        ${newTxnId}`)
        console.log(`   EditSequence: ${newEditSeq}`)
        console.log(`   RefNumber:    ${winner.RefNumber}`)
        console.log(`   TxnDate:      ${winner.TxnDate}`)
        console.log(`   TotalAmount:  $${winner.TotalAmount}`)
        console.log(`   Customer:     ${winner.CustomerRef?.FullName}`)
        console.log(`   Applied to IN-${INVOICE_NUMBER}: $${appliedAmount.toFixed(2)}`)

        if (DRY_RUN) {
            console.log(`\n[DRY RUN] would update customer_payment.qb + pipeline #${PIPELINE_SEQ} + edit-seq cache`)
            return
        }

        // ── 2. Update customer_payment.qb + metadata.qb_sync_status ─────────
        // qb.status="yes" + metadata.qb_sync_status="synced" is the convention
        // the POS UI checks to show the green-check QB SYNC badge.
        const newQbMeta = {
            source: "receive_payment",
            status: "yes",
            txn_id: newTxnId,
            edit_sequence: newEditSeq,
            ref_number: winner.RefNumber,
            txn_date: winner.TxnDate,
            recovered_from: payment.qb,
            recovered_at: new Date().toISOString(),
            recovery_note:
                `Original sales-receipt was voided. Manual ReceivePayment posted directly in QuickBooks ` +
                `applied $${appliedAmount.toFixed(2)} to IN-${INVOICE_NUMBER}; remaining $${(Number(payment.amount) / 100 - appliedAmount).toFixed(2)} stays available.`,
        }
        await client.query(
            `UPDATE customer_payment
             SET qb = $2::jsonb,
                 metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{qb_sync_status}', '"synced"'),
                 updated_at = now()
             WHERE id = $1`,
            [PAYMENT_ID, JSON.stringify(newQbMeta)],
        )
        console.log(`✅ customer_payment.qb + metadata.qb_sync_status updated`)

        // ── 3. Mark pipeline op as confirmed ─────────────────────────────────
        await client.query(
            `UPDATE qb_order_pipeline
             SET status         = 'confirmed',
                 qb_txn_id      = $2,
                 confirmed_at   = now(),
                 updated_at     = now(),
                 error          = NULL,
                 qb_result      = $3::jsonb
             WHERE seq = $1`,
            [
                PIPELINE_SEQ,
                newTxnId,
                JSON.stringify({
                    recovered: true,
                    note: "Linked to manually-applied QB ReceivePayment (bypassed POS)",
                    txn_id: newTxnId,
                    edit_sequence: newEditSeq,
                    ref_number: winner.RefNumber,
                }),
            ],
        )
        console.log(`✅ pipeline #${PIPELINE_SEQ} → confirmed`)

        // ── 4. Cache the fresh EditSequence ──────────────────────────────────
        await client.query(
            `INSERT INTO qb_edit_sequence_cache (entity_type, qb_id, edit_seq, cached_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (entity_type, qb_id)
             DO UPDATE SET edit_seq = EXCLUDED.edit_seq, cached_at = NOW()`,
            ["payment", newTxnId, newEditSeq],
        )
        console.log(`✅ qb_edit_sequence_cache updated`)

        console.log(`\n🎉 ${PAYMENT_DISPLAY} now linked to ReceivePayment ${newTxnId}; $46.85 remains usable.`)
    } finally {
        await client.end()
    }
}

main().catch(err => {
    console.error(`\n❌ Recovery failed:`, err instanceof Error ? err.message : String(err))
    process.exit(1)
})
