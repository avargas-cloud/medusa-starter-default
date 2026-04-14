/**
 * recover-multi-invoice-payment.ts
 *
 * Recovers a ReceivePayment in QuickBooks that was applied to only SOME of its
 * target invoices because of the old single-Mod bug (AppliedToTxnMod replace-all
 * semantics + stale EditSequence cache).
 *
 * Given a Medusa payment display_id (e.g. PAY-2017), this script:
 *   1. Looks up the payment in the DB to get its qb_txn_id and customer qb_list_id.
 *   2. Looks up every pos_invoice_payment_application row for that payment to
 *      determine the TARGET list of (invoiceTxnId, amount) pairs.
 *   3. Queries QB via the bridge for the payment's CURRENT state (fresh EditSeq +
 *      currently-applied list).
 *   4. Logs the diff: what Medusa thinks is applied vs. what QB actually has.
 *   5. Sends ONE ReceivePaymentMod via /api/payments/:txnId/merge-apply with the
 *      full target list — atomic, no race, no EditSeq issue.
 *
 * Usage (from backend/):
 *   yarn tsx src/scripts/qb_sync/data_rescue/recover-multi-invoice-payment.ts PAY-2017
 *   yarn tsx src/scripts/qb_sync/data_rescue/recover-multi-invoice-payment.ts PAY-2017 --dry-run
 *
 * Requires env: DATABASE_URL, QB_BRIDGE_URL, QB_API_KEY
 */

import { Client } from "pg"

const QB_BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com"
const QB_API_KEY = process.env.QB_API_KEY || ""
const DATABASE_URL = process.env.DATABASE_URL!
const DRY_RUN = process.argv.includes("--dry-run")

const POLL_INTERVAL_MS = 5000
const POLL_MAX_ATTEMPTS = 60  // 5 min

async function bridgeFetch(method: string, path: string, body?: any): Promise<any> {
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

async function main() {
    const payRef = process.argv[2]
    if (!payRef) {
        console.error("Usage: recover-multi-invoice-payment.ts <PAY-XXXX> [--dry-run]")
        process.exit(1)
    }
    const displayId = payRef.replace(/^PAY-/i, "")

    const client = new Client({
        connectionString: DATABASE_URL,
        ssl: DATABASE_URL.includes("railway") || DATABASE_URL.includes("sslmode")
            ? { rejectUnauthorized: false }
            : undefined,
    })
    await client.connect()

    try {
        // ── 1. Look up payment + customer ─────────────────────────────────────
        const payRes = await client.query(
            `SELECT cp.id, cp.customer_id, cp.metadata, cp.display_id,
                    c.metadata AS customer_metadata
             FROM customer_payment cp
             LEFT JOIN customer c ON c.id = cp.customer_id
             WHERE cp.display_id::text = $1 OR cp.id = $1
             LIMIT 1`,
            [displayId]
        )
        if (payRes.rows.length === 0) {
            throw new Error(`No payment found for display_id=${displayId}`)
        }
        const payment = payRes.rows[0]
        const paymentTxnId: string | undefined = payment.metadata?.qb_txn_id
        const customerListId: string | undefined = payment.customer_metadata?.qb_list_id

        if (!paymentTxnId) throw new Error(`Payment ${payRef} has no qb_txn_id in metadata`)
        if (!customerListId) throw new Error(`Customer ${payment.customer_id} has no qb_list_id in metadata`)

        console.log(`\n💰 Payment ${payRef} → QB TxnID: ${paymentTxnId}`)
        console.log(`👤 Customer QB ListID: ${customerListId}`)

        // ── 2. Build target applied list from finance applications ───────────
        const appRes = await client.query(
            `SELECT pipa.invoice_id,
                    pipa.amount_applied,
                    pi.metadata AS invoice_metadata,
                    pi.invoice_number
             FROM pos_invoice_payment_application pipa
             LEFT JOIN pos_invoice pi ON pi.id = pipa.invoice_id
             WHERE pipa.payment_id = $1
             ORDER BY pipa.created_at ASC`,
            [payment.id]
        )
        if (appRes.rows.length === 0) {
            throw new Error(`No invoice applications found for payment ${payRef}`)
        }

        const target: { invoiceId: string; amount: number; invoiceNumber: string }[] = []
        for (const row of appRes.rows) {
            const invTxnId: string | undefined = row.invoice_metadata?.qb_txn_id
            if (!invTxnId) {
                console.warn(`   ⚠️  Invoice ${row.invoice_number} has no qb_txn_id — SKIPPING`)
                continue
            }
            target.push({
                invoiceId: invTxnId,
                amount: Number(row.amount_applied) / 100, // cents → dollars
                invoiceNumber: row.invoice_number,
            })
        }

        console.log(`\n🎯 Target applications per Medusa:`)
        target.forEach(t => console.log(`   - ${t.invoiceNumber} (${t.invoiceId})  →  $${t.amount.toFixed(2)}`))

        // ── 3. Query QB for the live state of the payment ────────────────────
        console.log(`\n🔎 Fetching live QB state for payment ${paymentTxnId}...`)
        const enq = await bridgeFetch("GET", `/api/payments/${paymentTxnId}`)
        const opId = enq?.operationId
        if (!opId) throw new Error("Bridge returned no operationId for query")
        const raw = await pollRaw(opId)
        const msgs = raw?.QBXML?.QBXMLMsgsRs ?? raw?.QBXMLMsgsRs ?? raw ?? {}
        const retRaw =
            msgs?.ReceivePaymentQueryRs?.ReceivePaymentRet ??
            raw?.ReceivePaymentQueryRs?.ReceivePaymentRet ??
            raw?.ReceivePaymentRet ??
            null
        if (!retRaw) throw new Error("QB returned no ReceivePaymentRet")
        const ret: any = Array.isArray(retRaw) ? retRaw[0] : retRaw
        const liveEditSeq: string = String(ret.EditSequence)

        const appliedRaw = ret.AppliedToTxnRet
        const liveAppliedArr: any[] = appliedRaw
            ? Array.isArray(appliedRaw) ? appliedRaw : [appliedRaw]
            : []
        const liveApplied = liveAppliedArr
            .map(a => ({
                invoiceId: String(a?.TxnID || ""),
                amount: parseFloat(String(a?.Amount ?? "0")) || 0,
            }))
            .filter(a => a.invoiceId && a.amount > 0)

        console.log(`\n📸 QB live state: EditSeq=${liveEditSeq}`)
        console.log(`   Currently applied to ${liveApplied.length} invoice(s):`)
        liveApplied.forEach(a => console.log(`   - ${a.invoiceId}  →  $${a.amount.toFixed(2)}`))

        // ── 4. Diff ──────────────────────────────────────────────────────────
        const missing = target.filter(t => !liveApplied.some(l => l.invoiceId === t.invoiceId))
        const extra   = liveApplied.filter(l => !target.some(t => t.invoiceId === l.invoiceId))
        console.log(`\n🧮 Diff:`)
        console.log(`   Missing from QB (in Medusa but not in QB): ${missing.length}`)
        missing.forEach(m => console.log(`   + ${m.invoiceNumber} (${m.invoiceId})  $${m.amount.toFixed(2)}`))
        console.log(`   Extra in QB (in QB but not in Medusa):    ${extra.length}`)
        extra.forEach(e => console.log(`   - ${e.invoiceId}  $${e.amount.toFixed(2)}`))

        if (missing.length === 0 && extra.length === 0) {
            console.log(`\n✅ Already in sync — nothing to do.`)
            return
        }

        // ── 5. Merge-apply with the full target list ────────────────────────
        console.log(`\n📝 Will send merge-apply with ${target.length} application(s) (EditSeq=${liveEditSeq}).`)
        if (DRY_RUN) {
            console.log(`[DRY RUN] Skipping actual bridge call.`)
            return
        }

        const modEnq = await bridgeFetch("POST", `/api/payments/${paymentTxnId}/merge-apply`, {
            customerId: customerListId,
            editSequence: liveEditSeq,
            applications: target.map(t => ({ invoiceId: t.invoiceId, amount: t.amount })),
        })
        const modOpId = modEnq?.operationId
        if (!modOpId) throw new Error("Bridge returned no operationId for merge-apply")

        console.log(`\n⏳ Waiting for Mod to complete (opId=${modOpId})...`)
        const modRaw = await pollRaw(modOpId)
        const modMsgs = modRaw?.QBXML?.QBXMLMsgsRs ?? modRaw?.QBXMLMsgsRs ?? modRaw ?? {}
        const newRet = modMsgs?.ReceivePaymentModRs?.ReceivePaymentRet ?? null
        const newSeq = newRet?.EditSequence ?? null

        console.log(`\n✅ Merge-apply confirmed. New EditSequence: ${newSeq}`)
        console.log(`   Payment ${payRef} is now applied to ${target.length} invoice(s) in QB.`)

        // ── 6. Update the EditSequence cache in Medusa ──────────────────────
        if (newSeq) {
            await client.query(
                `INSERT INTO qb_edit_sequence_cache (entity_type, qb_id, edit_seq, cached_at)
                 VALUES ($1, $2, $3, NOW())
                 ON CONFLICT (entity_type, qb_id)
                 DO UPDATE SET edit_seq = EXCLUDED.edit_seq, cached_at = NOW()`,
                ["payment", paymentTxnId, String(newSeq)]
            )
            console.log(`   Cache updated.`)
        }
    } finally {
        await client.end()
    }
}

main().catch(err => {
    console.error(`\n❌ Recovery failed:`, err.message)
    process.exit(1)
})
