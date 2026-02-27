/**
 * test-qb-estimate-price.ts
 * 
 * Quick test: Create an Estimate with custom price + UnitOfMeasure
 * to verify QB uses the Medusa price without UOM multiplication.
 *
 * Usage:
 *   cd backend && npx -y tsx src/scripts/tests/test-qb-estimate-price.ts
 */

import { loadEnv } from "@medusajs/framework/utils"
loadEnv("development", process.cwd())

import { createEstimateInQb, pollOperationResult } from "../../lib/quickbooks/qb-bridge-client"

const CUSTOMER_ID = "8000004E-1342117388"  // EPT Alejandro Vargas
const PRODUCT_ID = "800019EA-1715274093"  // EAP-AS1-8S
const TODAY = new Date().toISOString().split("T")[0]

async function run() {
    console.log("=".repeat(60))
    console.log("Test: Estimate with price + UnitOfMeasure")
    console.log("=".repeat(60))
    console.log(`Price: $19.99   UOM: each   Qty: 2`)
    console.log(`Expected Amount in QB: $39.98 (not multiplied)\n`)

    const result = await createEstimateInQb({
        customerId: CUSTOMER_ID,
        date: TODAY,
        salesTaxCode: "Exempt",    // Test: verify QB shows $0 tax
        items: [{
            productId: PRODUCT_ID,
            quantity: 2,
            price: 19.99,
            unitOfMeasure: "each",
            desc: "EAP-AS1-8S - price test, safe to delete",
        }],
        memo: "Price test - $22.95 x 2 = $45.90 expected",
    })

    if (!result.success) {
        console.error("FAIL queueing:", result.error)
        process.exit(1)
    }

    console.log(`Queued: ${result.data!.operationId}`)
    console.log("Polling...")

    const poll = await pollOperationResult(result.data!.operationId)
    console.log(`\n TxnID:     ${poll.txnId}`)
    console.log(`RefNumber: ${poll.refNumber}`)
    console.log("\nCheck QB - the Unit Price column should show $22.95 and Total = $45.90")
    console.log("=".repeat(60))
}

run().catch(err => {
    console.error("ERROR:", err.message)
    process.exit(1)
})
