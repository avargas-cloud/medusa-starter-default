/**
 * test-qb-full-cycle.ts
 *
 * Layer 2: Live Bridge integration test — full order lifecycle.
 * Requires Bridge running at QB_BRIDGE_URL.
 *
 * Tests: Estimate → Convert-to-SO → Payment → Invoice → Apply Payment
 *
 * Usage:
 *   cd backend
 *   npx -y tsx src/scripts/tests/test-qb-full-cycle.ts
 *
 * Uses real customer: 8000004E-1342117388 (EPT Alejandro Vargas)
 * Uses real product:  800019EA-1715274093 (EAP-AS1-8S)
 */

import { loadEnv } from "@medusajs/framework/utils"
loadEnv("development", process.cwd())

import {
    checkBridgeHealth,
    createEstimateInQb,
    convertEstimateToSalesOrder,
    receivePaymentInQb,
    createInvoiceInQb,
    applyPaymentToInvoiceInQb,
    pollOperationResult,
} from "../../lib/quickbooks/qb-bridge-client"

// ─── Config ──────────────────────────────────────────────────────────────────

const CUSTOMER_ID = "8000004E-1342117388"    // EPT Alejandro Vargas
const PRODUCT_ID = "800019EA-1715274093"     // EAP-AS1-8S
const TEST_PRICE = 22.95
const TEST_QTY = 1
const TODAY = new Date().toISOString().split("T")[0]

const results: Record<string, { success: boolean; txnId?: string; refNumber?: string; error?: string }> = {}

// ─── Test Runner ─────────────────────────────────────────────────────────────

async function runFullCycle() {
    console.log("=".repeat(60))
    console.log("🧪 Layer 2: Live Bridge - Full Order Lifecycle Test")
    console.log("=".repeat(60))
    console.log(`📡 Bridge: ${process.env.QB_BRIDGE_URL || "https://ecopower-qb.loca.lt"}`)
    console.log(`👤 Customer: ${CUSTOMER_ID}`)
    console.log(`📦 Product: ${PRODUCT_ID} × ${TEST_QTY} @ $${TEST_PRICE}`)
    console.log(`📅 Date: ${TODAY}\n`)

    // ─── Pre-check: Health ─────────────────────────────────────────────
    console.log("─── Pre-check: Bridge Health ───")
    const healthy = await checkBridgeHealth()
    if (!healthy) {
        console.error("❌ Bridge is not healthy. Cannot run tests.")
        process.exit(1)
    }
    console.log("✅ Bridge is healthy\n")

    const testItems = [{
        productId: PRODUCT_ID,
        quantity: TEST_QTY,
    }]

    // ─── Step 1: Create Estimate ──────────────────────────────────────
    console.log("─── Step 1: Create Estimate ───")
    const estResult = await createEstimateInQb({
        customerId: CUSTOMER_ID,
        date: TODAY,
        items: testItems,
        memo: `Full cycle test ${new Date().toLocaleTimeString()} - safe to delete`,
    })

    if (!estResult.success) {
        console.error(`❌ Estimate creation failed: ${estResult.error}`)
        results.estimate = { success: false, error: estResult.error }
        printSummary()
        return
    }

    console.log(`✅ Queued! OperationID: ${estResult.data!.operationId}`)
    console.log("⏳ Polling for result...")

    const estPoll = await pollOperationResult(estResult.data!.operationId)
    results.estimate = { success: !!estPoll.txnId, txnId: estPoll.txnId, refNumber: estPoll.refNumber }
    console.log(`✅ Estimate → TxnID: ${estPoll.txnId}, Ref: ${estPoll.refNumber}\n`)

    if (!estPoll.txnId) {
        console.error("❌ No TxnID from estimate — cannot continue")
        printSummary()
        return
    }

    // ─── Step 2: Convert Estimate → Sales Order ──────────────────────
    console.log("─── Step 2: Convert Estimate → Sales Order ───")
    const convertResult = await convertEstimateToSalesOrder({
        estimateTxnId: estPoll.txnId,
        customerId: CUSTOMER_ID,
        date: TODAY,
        items: testItems,
        memo: `From Estimate ${estPoll.refNumber || estPoll.txnId}`,
    })

    if (!convertResult.success) {
        console.error(`❌ Convert failed: ${convertResult.error}`)
        results.salesOrder = { success: false, error: convertResult.error }
        printSummary()
        return
    }

    console.log(`✅ Queued! OperationID: ${convertResult.data!.operationId}`)
    console.log("⏳ Polling for result...")

    const soPoll = await pollOperationResult(convertResult.data!.operationId)
    results.salesOrder = { success: !!soPoll.txnId, txnId: soPoll.txnId, refNumber: soPoll.refNumber }
    console.log(`✅ Sales Order → TxnID: ${soPoll.txnId}, Ref: ${soPoll.refNumber}\n`)

    if (!soPoll.txnId) {
        console.error("❌ No TxnID from SO — cannot continue")
        printSummary()
        return
    }

    // ─── Step 3: Receive Payment ─────────────────────────────────────
    console.log("─── Step 3: Receive Payment (unapplied credit) ───")
    const payResult = await receivePaymentInQb({
        customerId: CUSTOMER_ID,
        amount: TEST_PRICE * TEST_QTY,
        paymentMethod: "Visa",
        refNumber: `P${Date.now().toString().slice(-6)}`,
        memo: `Payment for SO ${soPoll.refNumber || soPoll.txnId}`,
        autoApply: false,
    })

    if (!payResult.success) {
        console.error(`❌ Payment failed: ${payResult.error}`)
        results.payment = { success: false, error: payResult.error }
        printSummary()
        return
    }

    console.log(`✅ Queued! OperationID: ${payResult.data!.operationId}`)
    console.log("⏳ Polling for result...")

    const payPoll = await pollOperationResult(payResult.data!.operationId)
    results.payment = { success: !!payPoll.txnId, txnId: payPoll.txnId, refNumber: payPoll.refNumber }
    console.log(`✅ Payment → TxnID: ${payPoll.txnId}, Ref: ${payPoll.refNumber}\n`)

    if (!payPoll.txnId) {
        console.error("❌ No TxnID from payment — cannot continue")
        printSummary()
        return
    }

    // ─── Step 4: Create Invoice (linked to SO) ────────────────────────
    console.log("─── Step 4: Create Invoice (linked to SO) ───")
    const invResult = await createInvoiceInQb({
        customerId: CUSTOMER_ID,
        date: TODAY,
        LinkToTxnID: soPoll.txnId,
    })

    if (!invResult.success) {
        console.error(`❌ Invoice creation failed: ${invResult.error}`)
        results.invoice = { success: false, error: invResult.error }
        printSummary()
        return
    }

    console.log(`✅ Queued! OperationID: ${invResult.data!.operationId}`)
    console.log("⏳ Polling for result...")

    const invPoll = await pollOperationResult(invResult.data!.operationId)
    results.invoice = { success: !!invPoll.txnId, txnId: invPoll.txnId, refNumber: invPoll.refNumber }
    console.log(`✅ Invoice → TxnID: ${invPoll.txnId}, Ref: ${invPoll.refNumber}\n`)

    if (!invPoll.txnId) {
        console.error("❌ No TxnID from invoice — cannot apply payment")
        printSummary()
        return
    }

    // ─── Step 5: Apply Payment to Invoice ─────────────────────────────
    console.log("─── Step 5: Apply Payment to Invoice ───")
    const applyResult = await applyPaymentToInvoiceInQb({
        customerId: CUSTOMER_ID,
        amount: TEST_PRICE * TEST_QTY,
        invoiceId: invPoll.txnId,
        creditTxnId: payPoll.txnId,
    })

    if (!applyResult.success) {
        console.error(`❌ Apply payment failed: ${applyResult.error}`)
        results.applyPayment = { success: false, error: applyResult.error }
    } else {
        console.log(`✅ Queued! OperationID: ${applyResult.data!.operationId}`)
        console.log("⏳ Polling for result...")
        const applyPoll = await pollOperationResult(applyResult.data!.operationId)
        results.applyPayment = { success: true, txnId: applyPoll.txnId, refNumber: applyPoll.refNumber }
        console.log(`✅ Payment applied!\n`)
    }

    printSummary()
}

function printSummary() {
    console.log("\n" + "=".repeat(60))
    console.log("📊 FULL CYCLE TEST RESULTS")
    console.log("=".repeat(60))

    const steps = [
        ["Estimate", results.estimate],
        ["Sales Order", results.salesOrder],
        ["Payment", results.payment],
        ["Invoice", results.invoice],
        ["Apply Payment", results.applyPayment],
    ] as const

    for (const [name, result] of steps) {
        if (!result) {
            console.log(`  ⬜ ${name}: Not reached`)
        } else if (result.success) {
            console.log(`  ✅ ${name}: TxnID=${result.txnId || "?"}, Ref=${result.refNumber || "?"}`)
        } else {
            console.log(`  ❌ ${name}: ${result.error}`)
        }
    }

    const allSuccess = Object.values(results).every(r => r?.success)
    console.log("\n" + (allSuccess ? "🎉 ALL STEPS PASSED!" : "⚠️ Some steps failed") + "\n")
    console.log("=".repeat(60))

    if (!allSuccess) process.exit(1)
}

runFullCycle().catch(err => {
    console.error("❌ Test runner error:", err)
    process.exit(1)
})
