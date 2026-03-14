/**
 * verify-order-totals-patch.ts
 *
 * Verifica que el patch de Medusa #14628 esté aplicado correctamente.
 *
 * Modo 1 — Code check (siempre corre, sin necesidad de backend running):
 *   Confirma que la línea del fix existe en node_modules.
 *
 * Modo 2 — API check (requiere backend local corriendo + MEDUSA_ADMIN_TOKEN):
 *   Llama al Admin API local y confirma que los item totals son correctos.
 *   Para obtener el token: abre DevTools en localhost:9000/app → Network →
 *   busca cualquier request a /admin/ → copia el Authorization: Bearer <TOKEN>
 *
 * Usage:
 *   cd backend && npx dotenv-cli -e .env -- npx tsx src/scripts/verify/verify-order-totals-patch.ts
 *
 *   Con token (para API check):
 *   MEDUSA_ADMIN_TOKEN=eyJ... npx dotenv-cli -e .env -- npx tsx src/scripts/verify/verify-order-totals-patch.ts
 */

import * as fs from "fs"
import * as path from "path"
import * as dotenv from "dotenv"
dotenv.config()

const MEDUSA_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000"
const ADMIN_TOKEN = process.env.MEDUSA_ADMIN_TOKEN || ""

const SERVICE_FILE = path.resolve(
    process.cwd(), "node_modules/@medusajs/order/dist/services/order-module-service.js"
)

// ── Part 1: Static code check ────────────────────────────────────────────────

function checkCodeFix(): boolean {
    console.log("━━━ Part 1: Static code check ━━━\n")

    if (!fs.existsSync(SERVICE_FILE)) {
        console.error(`❌ File not found: ${SERVICE_FILE}`)
        return false
    }

    const content = fs.readFileSync(SERVICE_FILE, "utf-8")

    const hasFix = content.includes("requiredRelationsForTotals.includes(field)")
    const hasBug = content.includes("requiredRelationsForTotals.some((val) => val.startsWith(field))")

    if (hasFix && !hasBug) {
        console.log("✅ Patch is in place: `requires...includes(field)` found, bug line is gone")
        return true
    } else if (!hasFix && hasBug) {
        console.log("❌ Patch NOT applied: still has buggy `val.startsWith(field)` logic")
        console.log("   Run the patch manually or check patches/@medusajs+order+2.13.0.patch")
        return false
    } else if (hasFix && hasBug) {
        console.log("⚠️  Both lines found — manual edit may have left old code. Verify the file manually.")
        return false
    } else {
        console.log("⚠️  Neither pattern found — Medusa may have changed their implementation.")
        return false
    }
}

// ── Part 2: Live API check (optional) ───────────────────────────────────────

async function checkAdminAPI(): Promise<boolean> {
    console.log("\n━━━ Part 2: Live Admin API check ━━━\n")

    if (!ADMIN_TOKEN) {
        console.log("⚠️  No MEDUSA_ADMIN_TOKEN provided — skipping API check.")
        console.log("   To run API check:")
        console.log("   1. Start local backend: ./back")
        console.log("   2. Open DevTools at http://localhost:9000/app → Network tab")
        console.log("   3. Find any request → copy the 'Authorization: Bearer <TOKEN>' value")
        console.log("   4. Re-run: MEDUSA_ADMIN_TOKEN=<TOKEN> npx dotenv-cli -e .env -- npx tsx src/scripts/verify/verify-order-totals-patch.ts")
        return true  // Not an error — just skip
    }

    try {
        const res = await fetch(
            `${MEDUSA_URL}/admin/orders?fields=id,display_id,status,total,item_total,shipping_total,items.id,items.title,items.unit_price,items.quantity&limit=5&order=-created_at`,
            {
                headers: {
                    Authorization: `Bearer ${ADMIN_TOKEN}`,
                    "Content-Type": "application/json",
                },
            }
        )

        if (!res.ok) {
            console.error(`❌ API call failed (${res.status}) — check if backend is running at ${MEDUSA_URL}`)
            return false
        }

        const { orders } = await res.json()
        if (!orders?.length) {
            console.log("ℹ️  No orders found in API response")
            return true
        }

        console.log(`Checking ${orders.length} most recent orders:\n`)
        let allGood = true

        for (const order of orders) {
            const items = order.items ?? []
            const itemTotal = order.item_total ?? 0
            const shipping = order.shipping_total ?? 0
            const total = order.total ?? 0
            const onlyShipping = Math.abs(itemTotal) < 0.01 && shipping > 0 && order.status !== "canceled"

            const icon = onlyShipping ? "❌" : "✅"
            console.log(`${icon} #${order.display_id} [${order.status}]  total=${total?.toFixed?.(2)}  item_total=${itemTotal?.toFixed?.(2)}  shipping=${shipping?.toFixed?.(2)}`)

            items.forEach((i: any) => {
                const qty = i.quantity
                const line = (i.unit_price ?? 0) * (qty ?? 0)
                const qtyIcon = qty == null ? "⚠️" : "  "
                console.log(`   ${qtyIcon} "${i.title}" qty=${qty} × $${i.unit_price?.toFixed?.(2)} = $${line?.toFixed?.(2)}`)
            })

            if (onlyShipping) allGood = false
        }

        return allGood

    } catch (err: any) {
        console.error(`❌ Network error: ${err.message}`)
        console.log("   Is the local backend running? Check: curl http://localhost:9000/health")
        return false
    }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log("🔍 Verifying Medusa #14628 patch\n")

    const codeFix = checkCodeFix()
    const apiFix = await checkAdminAPI()

    console.log("\n" + "━".repeat(60))
    if (codeFix && apiFix) {
        console.log("✅ VERIFICATION PASSED")
        if (ADMIN_TOKEN) {
            console.log("   Both code check and API check passed — ready for deployment!")
        } else {
            console.log("   Code check passed. Please also verify manually in the Admin UI:")
            console.log("   → Restart local backend: tmux send-keys -t medusa-dev C-c && sleep 2 && yarn dev")
            console.log("   → Open http://localhost:9000/app/orders and confirm totals show correctly")
        }
    } else {
        console.log("❌ VERIFICATION FAILED — do NOT deploy yet")
        process.exit(1)
    }
}

main().catch(e => { console.error("❌", e.message); process.exit(1) })
