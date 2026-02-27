/**
 * test-qb-estimate.ts
 *
 * Phase 0: Validate that the QB Bridge supports POST /api/estimates.
 * Uses REAL customer and product data for validation.
 *
 * Usage:
 *   cd backend
 *   npx -y tsx src/scripts/tests/test-qb-estimate.ts
 *
 * Set QB_DRY_RUN=true to skip the actual Bridge call.
 */

import { loadEnv } from "@medusajs/framework/utils"

loadEnv("development", process.cwd())

const BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://ecopower-qb.loca.lt"
const API_KEY = process.env.QB_API_KEY || ""

async function testEstimateEndpoint() {
    console.log("=".repeat(60))
    console.log("🧪 Phase 0: Test QB Bridge — Estimates Endpoint")
    console.log("=".repeat(60))
    console.log(`\n📡 Bridge URL: ${BRIDGE_URL}`)
    console.log(`🔑 API Key: ${API_KEY ? API_KEY.substring(0, 8) + "..." : "NOT SET"}\n`)

    // ─── Step 1: Health Check ──────────────────────────────────────────
    console.log("─── Step 1: Health Check ───")
    try {
        const healthRes = await fetch(`${BRIDGE_URL}/health`, {
            headers: { "x-api-key": API_KEY },
        })
        const healthData = await healthRes.json()
        if (healthData?.status === "healthy") {
            console.log("✅ Bridge is healthy:", JSON.stringify(healthData))
        } else {
            console.log("⚠️  Bridge responded but status is not 'healthy':", healthData)
        }
    } catch (err: any) {
        console.error("❌ Bridge health check FAILED:", err.message)
        console.error("   Make sure the Bridge is running and the URL is correct.")
        process.exit(1)
    }

    // ─── Step 2: Look up product price from QB ─────────────────────────
    console.log("\n─── Step 2: Product Price Lookup ───")
    const PRODUCT_QB_LIST_ID = "800019EA-1715274093"
    let productPrice = 0

    try {
        const prodRes = await fetch(
            `${BRIDGE_URL}/api/products?ListID=${PRODUCT_QB_LIST_ID}`,
            { headers: { "x-api-key": API_KEY } }
        )
        const prodData = await prodRes.json()
        console.log("📦 Product from QB:", JSON.stringify(prodData, null, 2))
        productPrice = parseFloat(prodData?.SalesPrice || "0")
        console.log(`💰 Product price: $${productPrice}`)
    } catch (err: any) {
        console.log("⚠️  Could not fetch product price:", err.message)
        console.log("   Using fallback price: $10.00")
        productPrice = 10.00
    }

    // ─── Step 3: Send Test Estimate ────────────────────────────────────
    console.log("\n─── Step 3: Create Test Estimate ───")

    // Real data:
    //   Customer: EPT Alejandro Vargas (QB ListID: 8000004E-1342117388)
    //   Product:  EAP-AS1-8S = 8-feet Aluminum Channel Silver - AS1
    //             (QB ListID: 800019EA-1715274093)
    //
    // NOTE: Bridge uses customerId (ListID), NOT customerName
    const testPayload = {
        customerId: "8000004E-1342117388",   // EPT Alejandro Vargas
        date: new Date().toISOString().split("T")[0],
        items: [
            {
                productId: PRODUCT_QB_LIST_ID,
                quantity: 2,
                price: productPrice,
                desc: "8-feet Aluminum Channel Silver - AS1 (EAP-AS1-8S)",
            },
        ],
        memo: "Phase 0 test from Medusa — safe to delete",
    }

    console.log("📦 Payload:", JSON.stringify(testPayload, null, 2))

    if (process.env.QB_DRY_RUN === "true") {
        console.log("\n🔶 DRY RUN — Skipping actual Bridge call.")
        console.log("✅ Dry run complete. Set QB_DRY_RUN=false to test against live Bridge.")
        process.exit(0)
    }

    try {
        const res = await fetch(`${BRIDGE_URL}/api/estimates`, {
            method: "POST",
            headers: {
                "x-api-key": API_KEY,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(testPayload),
        })

        const status = res.status
        const text = await res.text()
        let data: any

        try {
            data = JSON.parse(text)
        } catch {
            data = text
        }

        console.log(`\n📬 Response Status: ${status}`)
        console.log("📬 Response Body:", JSON.stringify(data, null, 2))

        if (status >= 200 && status < 300) {
            // Bridge is async — returns operationId, not TxnID directly
            const operationId = data?.operationId
            if (operationId) {
                console.log(`\n✅ SUCCESS! Estimate queued with operationId: ${operationId}`)
                console.log("   → The Bridge SUPPORTS estimates.")
                console.log(`   → Poll for result: GET ${BRIDGE_URL}/api/sync/status/${operationId}`)
                console.log("   → Once completed, result will contain the TxnID.")
                console.log("\n   ⏳ Waiting 10s then polling for result...")

                // Auto-poll after 10 seconds
                await new Promise(resolve => setTimeout(resolve, 10_000))
                try {
                    const pollRes = await fetch(
                        `${BRIDGE_URL}/api/sync/status/${operationId}`,
                        { headers: { "x-api-key": API_KEY } }
                    )
                    const pollData = await pollRes.json()
                    console.log("📬 Poll Result:", JSON.stringify(pollData, null, 2))

                    if (pollData?.status === "completed") {
                        console.log("✅ Estimate CREATED in QuickBooks!")
                    } else {
                        console.log(`⏳ Status: ${pollData?.status || "unknown"} — try polling again in ~1 min`)
                        console.log(`   curl -H "x-api-key: ${API_KEY}" ${BRIDGE_URL}/api/sync/status/${operationId}`)
                    }
                } catch (pollErr: any) {
                    console.log("⚠️  Poll failed:", pollErr.message)
                    console.log(`   Manual poll: curl -H "x-api-key: ${API_KEY}" ${BRIDGE_URL}/api/sync/status/${operationId}`)
                }
            } else {
                // Fallback: maybe Bridge returned TxnID directly (older version)
                const txnId = data?.TxnID || data?.txnId || data?.id
                if (txnId) {
                    console.log(`\n✅ SUCCESS! Estimate created with TxnID: ${txnId}`)
                } else {
                    console.log("\n⚠️  Response was 2xx but no operationId or TxnID found.")
                    console.log("   Check the response body above.")
                }
            }
        } else if (status === 404) {
            console.log("\n❌ ENDPOINT NOT FOUND (404)")
            console.log("   → The Bridge does NOT support POST /api/estimates.")
            console.log("   → Need to add this endpoint to the Bridge before proceeding.")
        } else if (status === 401 || status === 403) {
            console.log("\n❌ AUTHENTICATION ERROR")
            console.log("   → Check QB_API_KEY in .env")
        } else {
            console.log(`\n❌ UNEXPECTED ERROR (${status})`)
            console.log("   → Review the response body above for details.")
        }
    } catch (err: any) {
        console.error("\n❌ Request FAILED:", err.message)
        if (err.cause?.code === "ECONNREFUSED") {
            console.error("   → Bridge is not running or port is wrong.")
        }
    }

    console.log("\n" + "=".repeat(60))
}

testEstimateEndpoint()
