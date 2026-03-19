/**
 * test-qb-payment-cycle.ts
 * 
 * Starts from Step 3: Payment → Invoice → Apply Payment
 * Uses the SO created in the previous test run.
 *
 * Usage:
 *   cd backend && npx -y tsx src/scripts/tests/test-qb-payment-cycle.ts
 */

import { loadEnv } from "@medusajs/utils"
loadEnv("development", process.cwd())

import {
    receivePaymentInQb,
    createInvoiceInQb,
    applyPaymentToInvoiceInQb,
    pollOperationResult,
} from "../../lib/quickbooks/qb-bridge-client"

// ─── From previous test run ─────────────────────────────────────────────────
const CUSTOMER_ID = "8000004E-1342117388"
const SO_TXN_ID = process.argv[2] || "1BA955-1772150734"  // SO from convert
const SO_REF = process.argv[3] || "6142"
const AMOUNT = 22.95
const TODAY = new Date().toISOString().split("T")[0]

async function run() {
    console.log("=".repeat(60))
    console.log("Steps 3-5: Payment -> Invoice -> Apply")
    console.log("=".repeat(60))
    console.log(`SO TxnID: ${SO_TXN_ID}`)
    console.log(`Customer: ${CUSTOMER_ID}`)
    console.log(`Amount: $${AMOUNT}\n`)

    // ─── Step 3: Receive Payment ─────────────────────────────────────
    console.log("--- Step 3: Receive Payment ---")
    const payResult = await receivePaymentInQb({
        customerId: CUSTOMER_ID,
        amount: AMOUNT,
        paymentMethod: "Visa",
        refNumber: `P${Date.now().toString().slice(-6)}`,
        memo: `Payment for SO ${SO_REF}`,
        autoApply: false,
    })

    if (!payResult.success) {
        console.error(`FAIL: ${payResult.error}`)
        process.exit(1)
    }

    console.log(`Queued: ${payResult.data!.operationId}`)
    const payPoll = await pollOperationResult(payResult.data!.operationId)
    console.log(`Payment OK: TxnID=${payPoll.txnId}, Ref=${payPoll.refNumber}\n`)

    // ─── Step 4: Create Invoice ──────────────────────────────────────
    console.log("--- Step 4: Create Invoice (linked to SO) ---")
    const invResult = await createInvoiceInQb({
        customerId: CUSTOMER_ID,
        date: TODAY,
        LinkToTxnID: SO_TXN_ID,
    })

    if (!invResult.success) {
        console.error(`FAIL: ${invResult.error}`)
        process.exit(1)
    }

    console.log(`Queued: ${invResult.data!.operationId}`)
    const invPoll = await pollOperationResult(invResult.data!.operationId)
    console.log(`Invoice OK: TxnID=${invPoll.txnId}, Ref=${invPoll.refNumber}\n`)

    // ─── Step 5: Apply Payment to Invoice ────────────────────────────
    console.log("--- Step 5: Apply Payment to Invoice ---")
    const applyResult = await applyPaymentToInvoiceInQb({
        customerId: CUSTOMER_ID,
        amount: AMOUNT,
        invoiceId: invPoll.txnId!,
        creditTxnId: payPoll.txnId!,
    })

    if (!applyResult.success) {
        console.error(`FAIL: ${applyResult.error}`)
        process.exit(1)
    }

    console.log(`Queued: ${applyResult.data!.operationId}`)
    const applyPoll = await pollOperationResult(applyResult.data!.operationId)
    console.log(`Apply OK: TxnID=${applyPoll.txnId}\n`)

    console.log("=".repeat(60))
    console.log("ALL 3 STEPS PASSED!")
    console.log(`  Payment:  ${payPoll.txnId} (${payPoll.refNumber})`)
    console.log(`  Invoice:  ${invPoll.txnId} (${invPoll.refNumber})`)
    console.log(`  Applied:  ${applyPoll.txnId}`)
    console.log("=".repeat(60))
}

run().catch(err => {
    console.error("ERROR:", err.message)
    process.exit(1)
})
