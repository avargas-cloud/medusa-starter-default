/**
 * verify-qb-subscribers.ts
 *
 * Layer 3: Validates QB subscriber configuration.
 * Checks exports, event bindings, and function imports are correct.
 *
 * Usage:
 *   cd backend
 *   npx -y tsx src/scripts/verify/verify-qb-subscribers.ts
 */

let passed = 0
let failed = 0

function assert(condition: boolean, name: string, detail?: string) {
    if (condition) {
        console.log(`  ✅ ${name}`)
        passed++
    } else {
        console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`)
        failed++
    }
}

async function verifySubscribers() {
    console.log("=".repeat(60))
    console.log("🧪 Layer 3: Subscriber Configuration Verification")
    console.log("=".repeat(60))

    // ─── Check 1: qb-order-subscriber ─────────────────────────────────
    console.log("\n─── qb-order-subscriber.ts ───")
    try {
        const orderSub = await import("../../subscribers/qb-order-subscriber")

        assert(typeof orderSub.default === "function", "Default export is a function")
        assert(!!orderSub.config, "Has config export")
        assert(Array.isArray(orderSub.config?.event), "config.event is an array")

        const events = orderSub.config?.event || []
        assert(events.includes("order.placed"), "Handles order.placed")
        assert(events.includes("order.payment_captured"), "Handles order.payment_captured")
        assert(events.includes("order.fulfillment_created"), "Handles order.fulfillment_created")
        assert(orderSub.config?.context?.subscriberId === "qb-order-subscriber", `SubscriberId: ${orderSub.config?.context?.subscriberId}`)
    } catch (err: any) {
        console.log(`  ❌ Import failed: ${err.message}`)
        failed++
    }

    // ─── Check 2: qb-draft-order-subscriber ───────────────────────────
    console.log("\n─── qb-draft-order-subscriber.ts ───")
    try {
        const draftSub = await import("../../subscribers/qb-draft-order-subscriber")

        assert(typeof draftSub.default === "function", "Default export is a function")
        assert(!!draftSub.config, "Has config export")

        const events = draftSub.config?.event || []
        assert(events.includes("draft_order.created"), "Handles draft_order.created")
        assert(draftSub.config?.context?.subscriberId === "qb-draft-order-subscriber", `SubscriberId: ${draftSub.config?.context?.subscriberId}`)
    } catch (err: any) {
        console.log(`  ❌ Import failed: ${err.message}`)
        failed++
    }

    // ─── Check 3: Bridge client exports ───────────────────────────────
    console.log("\n─── qb-bridge-client.ts exports ───")
    try {
        const client = await import("../../lib/quickbooks/qb-bridge-client")

        const requiredFns = [
            "checkBridgeHealth",
            "createCustomerInQb",
            "createSalesOrderInQb",
            "convertEstimateToSalesOrder",
            "receivePaymentInQb",
            "createInvoiceInQb",
            "createEstimateInQb",
            "applyPaymentToInvoiceInQb",
            "pollOperationResult",
        ]

        for (const fn of requiredFns) {
            assert(typeof (client as any)[fn] === "function", `Exports ${fn}()`)
        }
    } catch (err: any) {
        console.log(`  ❌ Import failed: ${err.message}`)
        failed++
    }

    // ─── Check 4: order-flow-core exports ─────────────────────────────
    console.log("\n─── order-flow-core.ts exports ───")
    try {
        const core = await import("../../lib/quickbooks/order-flow-core")

        const requiredFns = [
            "processOrderInQb",
            "processPaymentCaptureInQb",
            "processInvoiceInQb",
            "processEstimateInQb",
            "ensureCustomerInQb",
            "buildQbItems",
        ]

        for (const fn of requiredFns) {
            assert(typeof (core as any)[fn] === "function", `Exports ${fn}()`)
        }
    } catch (err: any) {
        console.log(`  ❌ Import failed: ${err.message}`)
        failed++
    }

    // ─── Summary ──────────────────────────────────────────────────────
    console.log("\n" + "=".repeat(60))
    console.log(`📊 Results: ${passed} passed, ${failed} failed (${passed + failed} total)`)
    console.log("=".repeat(60))

    if (failed > 0) process.exit(1)
}

verifySubscribers().catch(err => {
    console.error("❌ Verification error:", err)
    process.exit(1)
})
