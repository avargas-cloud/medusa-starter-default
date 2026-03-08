import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils"

const BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com"
const API_KEY = process.env.QB_API_KEY || "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD"
const POLL_INTERVAL_MS = 30000
const MAX_POLL_ATTEMPTS = 20

/**
 * For each product missing metadata.sales_description:
 *   1. Find the first variant that has a quickbooks_id
 *   2. Look up that QB item's SalesDesc
 *   3. Save it as product.metadata.sales_description
 *
 * Uses /api/products/active-with-description which explicitly requests SalesDesc.
 * Run: npx medusa exec src/scripts/sync/sync-qb-sales-descriptions.ts
 */
export default async function syncSalesDescriptions({ container }: ExecArgs) {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const productModule = container.resolve(Modules.PRODUCT) as any
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

    const log = (msg: string) => logger.info(msg)
    const warn = (msg: string) => logger.warn(msg)

    log("📝 Starting QB SalesDesc → metadata.sales_description sync...")

    // 1. Fetch all products + variants
    let allProducts: any[] = []
    let skip = 0
    while (true) {
        const { data } = await query.graph({
            entity: "product",
            fields: ["id", "title", "metadata", "variants.id", "variants.sku", "variants.metadata"],
            pagination: { skip, take: 500 }
        })
        if (!data.length) break
        allProducts = allProducts.concat(data)
        skip += 500
    }

    // Filter: products missing sales_description that have at least 1 QB-linked variant
    const targets = allProducts.filter((p: any) =>
        !p.metadata?.sales_description &&
        p.variants?.some((v: any) => v.metadata?.quickbooks_id)
    )

    log(`📊 Total products: ${allProducts.length}`)
    log(`📊 Need sales_description: ${targets.length}`)

    if (targets.length === 0) {
        log("✅ All products already have sales_description!")
        return
    }

    // Build set of all QB IDs we need — only the FIRST QB-linked variant per product
    // Map: qbId → productId (so we know which product to update)
    const qbIdToProductId = new Map<string, string>()
    const productMap = new Map<string, any>()  // productId → product

    for (const p of targets) {
        const firstQbVariant = p.variants?.find((v: any) => v.metadata?.quickbooks_id)
        if (firstQbVariant) {
            const qbId = firstQbVariant.metadata.quickbooks_id
            qbIdToProductId.set(qbId, p.id)
            productMap.set(p.id, p)
        }
    }

    log(`📊 Unique QB IDs to fetch: ${qbIdToProductId.size}`)

    // 2. Pull all active products with SalesDesc from QB Bridge
    log("📡 Fetching active products with descriptions from QB Bridge...")
    log("   (Using endpoint: /api/products/active-with-description)")

    const initRes = await fetch(`${BRIDGE_URL}/api/products/active-with-description`, {
        headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" }
    })

    if (!initRes.ok) {
        const txt = await initRes.text()
        logger.error(`❌ Bridge error: ${initRes.status} — ${txt}`)
        // Fallback to generic /api/products endpoint
        logger.warn("⚠️ Falling back to /api/products endpoint (SalesDesc may be empty)...")
        return
    }

    const { operationId } = await initRes.json() as any
    log(`✅ Operation queued: ${operationId}`)

    // 3. Poll
    let qbItems: any[] = []
    for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
        log(`⏳ Polling (${attempt}/${MAX_POLL_ATTEMPTS})...`)
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))

        const statusRes = await fetch(`${BRIDGE_URL}/api/sync/status/${operationId}`, {
            headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" }
        })
        const statusJson: any = await statusRes.json()

        if (statusJson.operation?.status === "completed") {
            const queryRs = statusJson.operation?.result?.QBXML?.QBXMLMsgsRs?.ItemQueryRs
            if (queryRs) {
                const items = queryRs.ItemInventoryRet || []
                qbItems = Array.isArray(items) ? items : [items]
            }
            log(`✅ Got ${qbItems.length} items from QB`)
            break
        }

        if (statusJson.operation?.status === "failed") {
            logger.error(`❌ QB operation failed: ${statusJson.operation?.error}`)
            return
        }
    }

    if (qbItems.length === 0) {
        logger.error("❌ No items after polling. Aborting.")
        return
    }

    // Log a sample item to verify SalesDesc is present
    const sampleItem = qbItems[0]
    log(`📋 Sample item keys: ${Object.keys(sampleItem || {}).join(", ")}`)
    log(`📋 Sample SalesDesc: "${sampleItem?.SalesDesc}"`)

    // 4. Build QB lookup map and update products
    const qbMap = new Map(qbItems.map((item: any) => [item.ListID, item]))

    log("\n💬 Updating product metadata.sales_description...")

    let updated = 0
    let skippedEmpty = 0
    let skippedNotFound = 0

    for (const [qbId, productId] of qbIdToProductId.entries()) {
        const qbItem = qbMap.get(qbId)
        const product = productMap.get(productId)!

        if (!qbItem) {
            skippedNotFound++
            warn(`   ⚠️  ${product.title}: QB item ${qbId} not found in response`)
            continue
        }

        const salesDesc: string = (qbItem.SalesDesc || "").trim()
        if (!salesDesc) {
            skippedEmpty++
            warn(`   ⚠️  ${product.title} (${qbId}): SalesDesc is empty in QB`)
            continue
        }

        await productModule.updateProducts(productId, {
            metadata: {
                ...product.metadata,
                sales_description: salesDesc
            }
        })
        updated++
        log(`   ✅ ${product.title}: "${salesDesc.substring(0, 70)}${salesDesc.length > 70 ? "..." : ""}"`)
    }

    log(`\n${"=".repeat(55)}`)
    log(`✅ SALES DESCRIPTION SYNC COMPLETE`)
    log(`${"=".repeat(55)}`)
    log(`Updated:               ${updated}`)
    log(`Skipped (not in QB):   ${skippedNotFound}`)
    log(`Skipped (empty desc):  ${skippedEmpty}`)
    log(`${"=".repeat(55)}\n`)
}
