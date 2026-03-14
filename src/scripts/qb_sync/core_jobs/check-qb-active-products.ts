#!/usr/bin/env tsx
/**
 * check-qb-active-products.ts  v2
 *
 * Fetches ALL items from the QuickBooks Bridge (/api/products),
 * filters to ACTIVE items only, and saves to a JSON file for review.
 *
 * Fields captured per product:
 *   - listId       (QuickBooks internal ID)
 *   - sku          (Full name / SKU in QB)
 *   - description  (Sales description)
 *   - price        (SalesPrice)
 *   - quantity     (QuantityOnHand)
 *   - isActive     (true/false)
 *
 * Usage:
 *   npx tsx src/scripts/checks/check-qb-active-products.ts
 *
 * Output:
 *   /tmp/qb-active-products.json
 */

import fs from "fs"
import path from "path"

const BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com"
const API_KEY = process.env.QB_API_KEY || "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD"
const POLL_INTERVAL_MS = 30_000  // 30 seconds
const MAX_POLL_ATTEMPTS = 20      // 10 minutes max
const OUTPUT_FILE = "/tmp/qb-active-products.json"
const RAW_SAMPLE_FILE = "/tmp/qb-sample-raw.xml"   // first 5 blocks for tag inspection

// ── Retry helper ─────────────────────────────────────────────────────────────
async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 3): Promise<Response> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const res = await fetch(url, options)
            if (res.ok || ![502, 503, 504].includes(res.status)) return res
            console.warn(`[retry] Bridge returned ${res.status} (attempt ${attempt}/${maxRetries})`)
            if (attempt < maxRetries) await new Promise(r => setTimeout(r, 8_000))
        } catch (err: any) {
            console.warn(`[retry] Fetch error (attempt ${attempt}/${maxRetries}): ${err.message}`)
            if (attempt === maxRetries) throw err
            await new Promise(r => setTimeout(r, 8_000))
        }
    }
    throw new Error("All retries exhausted")
}

// ── XML helpers ───────────────────────────────────────────────────────────────
function extractXml(block: string, tag: string): string {
    // Handles multi-line and CDATA content
    return block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1]?.trim() ?? ""
}

// Try multiple tag alternatives and return the first non-empty one
function extractXmlAny(block: string, ...tags: string[]): string {
    for (const tag of tags) {
        const val = extractXml(block, tag)
        if (val) return val
    }
    return ""
}

// ── Parse raw XML string into item array ─────────────────────────────────────
function parseXmlItems(rawXml: string): any[] {
    const blocks = rawXml.match(/<Item[a-zA-Z]+Ret>[\s\S]*?<\/Item[a-zA-Z]+Ret>/g) || []

    // Save first 5 ItemInventoryRet blocks specifically (they have price/desc/qty)
    const invBlocks = blocks.filter(b => b.startsWith("<ItemInventoryRet>"))
    const sampleBlocks = invBlocks.length > 0 ? invBlocks.slice(0, 5) : blocks.slice(0, 5)
    if (sampleBlocks.length > 0) {
        fs.writeFileSync(RAW_SAMPLE_FILE, sampleBlocks.join("\n\n---\n\n"), "utf8")
        console.log(`📝 Raw XML sample (ItemInventoryRet) saved to: ${RAW_SAMPLE_FILE}`)
    }

    return blocks.map(block => ({
        listId: extractXml(block, "ListID"),
        sku: extractXmlAny(block, "FullName", "Name"),
        // QB Sales Description — try all known tag variants
        description: extractXmlAny(block, "SalesDesc", "SalesDescription", "Desc", "Description", "PurchaseDesc"),
        price: extractXmlAny(block, "SalesPrice", "Price"),
        quantity: extractXmlAny(block, "QuantityOnHand", "QtyOnHand"),
        isActive: extractXml(block, "IsActive").toLowerCase() !== "false",
        type: block.match(/<(Item[a-zA-Z]+)Ret>/)?.[1] ?? "Unknown",
    })).filter(i => i.listId)
}

// ── Parse JSON response (fallback) ───────────────────────────────────────────
function parseJsonItems(queryRs: any): any[] {
    const inventoryItems: any[] = Array.isArray(queryRs.ItemInventoryRet) ? queryRs.ItemInventoryRet : queryRs.ItemInventoryRet ? [queryRs.ItemInventoryRet] : []
    const nonInventoryItems: any[] = Array.isArray(queryRs.ItemNonInventoryRet) ? queryRs.ItemNonInventoryRet : queryRs.ItemNonInventoryRet ? [queryRs.ItemNonInventoryRet] : []
    const serviceItems: any[] = Array.isArray(queryRs.ItemServiceRet) ? queryRs.ItemServiceRet : queryRs.ItemServiceRet ? [queryRs.ItemServiceRet] : []

    return [...inventoryItems, ...nonInventoryItems, ...serviceItems].map(item => ({
        listId: item.ListID ?? "",
        sku: item.FullName ?? item.Name ?? "",
        description: item.SalesDesc ?? item.PurchaseDesc ?? "",
        price: item.SalesPrice ?? "",
        quantity: item.QuantityOnHand ?? "",
        isActive: item.IsActive !== false && item.IsActive !== "false",
        type: item.Type ?? "Unknown",
    })).filter(i => i.listId)
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    console.log("=".repeat(60))
    console.log("🔍 QB Active Products Check")
    console.log(`📡 Bridge: ${BRIDGE_URL}`)
    console.log(`📄 Output: ${OUTPUT_FILE}`)
    console.log("=".repeat(60))

    // 1. Initiate the bulk product fetch (uses new endpoint that includes SalesDesc)
    console.log("\n📡 Initiating active-with-description request from QB Bridge...")
    const initRes = await fetchWithRetry(`${BRIDGE_URL}/api/products/active-with-description`, {
        headers: {
            "x-api-key": API_KEY,
            "bypass-tunnel-reminder": "true",
        }
    })

    if (!initRes.ok) {
        const body = await initRes.text().catch(() => "")
        console.error(`❌ Bridge error: ${initRes.status} ${initRes.statusText}`)
        if (body) console.error(`   ${body.slice(0, 300)}`)
        process.exit(1)
    }

    const initJson: any = await initRes.json()
    const operationId: string = initJson.operationId
    console.log(`✅ Operation queued — ID: ${operationId}`)
    console.log(`\n⏳ Polling every 30s (up to 10 min) while QB Web Connector processes...\n`)

    // 2. Polling loop
    let rawItems: any[] = []
    let attempts = 0

    while (attempts < MAX_POLL_ATTEMPTS) {
        attempts++
        console.log(`   Poll ${attempts}/${MAX_POLL_ATTEMPTS}...`)

        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))

        const statusRes = await fetch(`${BRIDGE_URL}/api/sync/status/${operationId}`, {
            headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" }
        })

        if (!statusRes.ok) {
            console.warn(`   ⚠️  Status check error: ${statusRes.status}`)
            continue
        }

        const statusJson: any = await statusRes.json()

        if (statusJson.success && statusJson.operation) {
            const op = statusJson.operation

            if (op.status === "completed") {
                // Try raw XML first
                if (op.qbxmlResponse) {
                    console.log("📦 Received raw XML — parsing...")
                    rawItems = parseXmlItems(op.qbxmlResponse)
                    console.log(`✅ Parsed ${rawItems.length} items from XML`)
                    break
                }

                // Try structured JSON
                const queryRs = op.result?.QBXML?.QBXMLMsgsRs?.ItemQueryRs
                    ?? op.result?.ItemQueryRs
                if (queryRs) {
                    console.log("📦 Received JSON response — parsing...")
                    rawItems = parseJsonItems(queryRs)
                    console.log(`✅ Parsed ${rawItems.length} items from JSON`)
                    break
                }

                // Last resort: raw data array
                if (Array.isArray(op.data)) {
                    console.log("📦 Using raw data array...")
                    rawItems = op.data
                    break
                }

                console.warn("⚠️  Completed but no parseable data found.")
                console.log("   Available keys:", JSON.stringify(Object.keys(op.result ?? {})))
                break
            }

            if (op.status === "failed") {
                console.error(`❌ QB operation failed: ${op.error || op.message || "Unknown"}`)
                process.exit(1)
            }

            console.log(`   Status: ${op.status} — still waiting...`)
        }
    }

    if (rawItems.length === 0) {
        console.error("\n❌ Timed out or received empty response from QB Bridge.")
        process.exit(1)
    }

    // 3. Filter active only
    const activeItems = rawItems.filter(i => i.isActive !== false && i.isActive !== "false")
    const inactiveCount = rawItems.length - activeItems.length

    console.log("\n" + "=".repeat(60))
    console.log("📊 RESULTS")
    console.log("-".repeat(40))
    console.log(`   Total items from QB:   ${rawItems.length}`)
    console.log(`   Active items:          ${activeItems.length}`)
    console.log(`   Inactive (filtered):   ${inactiveCount}`)
    console.log("=".repeat(60))

    // 4. Build output
    const output = {
        generatedAt: new Date().toISOString(),
        bridgeUrl: BRIDGE_URL,
        totalFetched: rawItems.length,
        totalActive: activeItems.length,
        totalInactive: inactiveCount,
        products: activeItems.map(item => ({
            listId: item.listId,
            sku: item.sku,
            description: item.description,
            price: item.price !== "" ? parseFloat(item.price) : null,
            quantity: item.quantity !== "" ? parseInt(item.quantity, 10) : null,
            type: item.type,
        }))
    }

    // 5. Save to file
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf8")
    console.log(`\n✅ Saved to: ${OUTPUT_FILE}`)
    console.log(`\n💡 To open and review:`)
    console.log(`   cat ${OUTPUT_FILE} | python3 -m json.tool | less`)
    console.log(`   code ${OUTPUT_FILE}`)
    console.log(`\n💡 Quick stats:`)
    console.log(`   cat ${OUTPUT_FILE} | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Active: {d[\\\"totalActive\\\"]}, Inactive: {d[\\\"totalInactive\\\"]}')"\n`)
}

main().catch(err => {
    console.error("❌ Fatal:", err)
    process.exit(1)
})
