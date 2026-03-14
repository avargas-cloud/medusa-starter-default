/**
 * link-missing-qb-ids.ts
 *
 * Fetches the COMPLETE QuickBooks inventory in ONE request (GET /api/products/site/:siteId),
 * builds a SKU → ListID map locally, then updates any Medusa variant that is missing
 * quickbooks_id in its metadata.
 *
 * Much faster than batch-lookup (1 QB request total vs. 1 per SKU).
 *
 * Usage:
 *   cd backend
 *   DATABASE_URL="..." npx tsx src/scripts/quickbooks/link-missing-qb-ids.ts [--dry-run]
 *
 * Options:
 *   --dry-run  Print what would be updated without saving anything
 */

import { Client } from "pg"

const QB_BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com"
const QB_API_KEY = process.env.QB_API_KEY || "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD"
const DATABASE_URL = process.env.DATABASE_URL!
const DRY_RUN = process.argv.includes("--dry-run")

const QB_SITE_ID = "80000001-1331053531"   // Principal Warehouse
const POLL_INTERVAL_MS = 30_000                   // 30s between poll attempts
const POLL_MAX_ATTEMPTS = 20                      // 10 min max
const UPDATE_DELAY_MS = 50                       // small delay between DB writes

// ─── Bridge helpers ─────────────────────────────────────────────────────────

async function bridgeFetch(method: string, path: string): Promise<any> {
    const res = await fetch(`${QB_BRIDGE_URL}${path}`, {
        method,
        headers: {
            "x-api-key": QB_API_KEY,
            "bypass-tunnel-reminder": "true",
        },
    })
    if (!res.ok) throw new Error(`Bridge ${method} ${path} → ${res.status}: ${await res.text()}`)
    return res.json()
}

async function pollForInventory(operationId: string): Promise<any[]> {
    for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
        console.log(`  ⏳ Polling (${attempt}/${POLL_MAX_ATTEMPTS}) — waiting for QB Web Connector...`)
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))

        const statusRes = await bridgeFetch("GET", `/api/sync/status/${operationId}`)
        const op = statusRes?.operation

        if (!op) continue

        if (op.status === "completed") {
            const queryRs = op?.result?.QBXML?.QBXMLMsgsRs?.ItemSitesQueryRs
            if (queryRs) {
                const raw = queryRs.ItemSitesRet || []
                return Array.isArray(raw) ? raw : [raw]
            }
            throw new Error("QB returned completed but no ItemSitesQueryRs in result")
        }

        if (op.status === "failed") {
            throw new Error(`QB operation failed: ${op.error || "Unknown"}`)
        }

        console.log(`     Status: ${op.status}`)
    }
    throw new Error(`Polling timed out after ${POLL_MAX_ATTEMPTS} attempts`)
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const db = new Client({ connectionString: DATABASE_URL })
    await db.connect()

    // ── 1. Find variants missing quickbooks_id ─────────────────────────────
    console.log(`\n🔍 Finding variants without quickbooks_id...\n`)

    const { rows: variants } = await db.query(`
        SELECT pv.id, pv.sku, pv.metadata
        FROM product_variant pv
        WHERE pv.sku IS NOT NULL
          AND pv.sku != ''
          AND (
              pv.metadata IS NULL
              OR pv.metadata->>'quickbooks_id' IS NULL
              OR pv.metadata->>'quickbooks_id' = ''
          )
        ORDER BY pv.sku
    `)

    if (variants.length === 0) {
        console.log("✅ All variants already have quickbooks_id set!\n")
        await db.end()
        return
    }

    console.log(`Found ${variants.length} variants missing quickbooks_id:`)
    variants.forEach(v => console.log(`  • ${v.sku}`))
    console.log()
    if (DRY_RUN) console.log("🔵 DRY RUN — will not save anything.\n")

    // ── 2. Fetch FULL QB inventory (one request) ───────────────────────────
    console.log(`📡 Fetching complete QB inventory from Principal Warehouse...`)
    const initData = await bridgeFetch("GET", `/api/products/site/${QB_SITE_ID}`)
    const operationId = initData.operationId

    if (!operationId) throw new Error("Bridge did not return operationId for inventory fetch")
    console.log(`  ✅ Operation queued: ${operationId}`)

    const qbItems = await pollForInventory(operationId)
    console.log(`  📦 Received ${qbItems.length} QB inventory records\n`)

    // ── 3. Build SKU → ListID map from QB data ─────────────────────────────
    // ItemSitesRet: { ItemInventoryRef: { ListID, FullName }, QuantityOnHand }
    const skuToListId: Record<string, string> = {}
    for (const item of qbItems) {
        const listId = item.ItemInventoryRef?.ListID
        const fullName = item.ItemInventoryRef?.FullName   // This is the full QB name (may include parent:child)
        const name = fullName?.split(":").pop()?.trim()  // Last segment = item Name = SKU
        if (listId && name) {
            skuToListId[name] = listId
            if (fullName !== name) skuToListId[fullName] = listId  // also index by FullName
        }
    }

    console.log(`  🗺️  Mapped ${Object.keys(skuToListId).length} unique QB items by name\n`)

    // ── 4. Match Medusa variants against QB items ──────────────────────────
    const matched = variants.filter(v => skuToListId[v.sku])
    const unmatched = variants.filter(v => !skuToListId[v.sku])

    console.log(`📊 Match Results:`)
    matched.forEach(v => console.log(`  ✅ ${v.sku} → ${skuToListId[v.sku]}`))
    unmatched.forEach(v => console.log(`  ❌ No QB match: ${v.sku}`))
    console.log()

    if (matched.length === 0) {
        console.log("No matches found — check that QB item names match Medusa SKUs exactly.\n")
        await db.end()
        return
    }

    // ── 5. Save quickbooks_id to variants ─────────────────────────────────
    console.log(`${DRY_RUN ? "🔵 [DRY RUN]" : "💾"} Saving quickbooks_id to ${matched.length} variants...`)
    let saved = 0, failed = 0

    for (const v of matched) {
        const qbId = skuToListId[v.sku]
        const newMeta = { ...(v.metadata || {}), quickbooks_id: qbId }

        if (!DRY_RUN) {
            try {
                await db.query(
                    `UPDATE product_variant SET metadata = $1 WHERE id = $2`,
                    [JSON.stringify(newMeta), v.id]
                )
                saved++
                await new Promise(r => setTimeout(r, UPDATE_DELAY_MS))
            } catch (err: any) {
                console.error(`  ❌ Failed to update ${v.sku}: ${err.message}`)
                failed++
            }
        }
    }

    const summary = DRY_RUN
        ? `\n🔵 DRY RUN done — ${matched.length} would be updated. Remove --dry-run to apply.`
        : `\n✅ Done! Saved: ${saved}, Failed: ${failed}`
    console.log(summary)

    if (unmatched.length > 0) {
        console.log(`⚠️  ${unmatched.length} SKUs had no QB match — set them manually or add the products to QB first.`)
        console.log(`   Missing: ${unmatched.map(v => v.sku).join(", ")}`)
    }

    await db.end()
}

main().catch(err => {
    console.error("❌ Fatal error:", err.message)
    process.exit(1)
})
