import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils"

const BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com"
const API_KEY = process.env.QB_API_KEY || "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD"
const POLL_INTERVAL_MS = 30000
const MAX_POLL_ATTEMPTS = 20

/**
 * Migrates sales_description from product.metadata → variant.metadata
 *
 * Strategy:
 *   1. Try QB Bridge: matches variant.metadata.quickbooks_id → QB item ListID → SalesDesc
 *   2. Fallback for variants without quickbooks_id: copy from product.metadata.sales_description
 *
 * Run:  npx medusa exec src/scripts/migrate/migrate-variant-sales-descriptions.ts
 */
export default async function migrateVariantSalesDescriptions({ container }: ExecArgs) {
    const query = container.resolve(ContainerRegistrationKeys.QUERY) as any
    const productModule = container.resolve(Modules.PRODUCT) as any
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER) as any

    const log = (msg: string) => logger.info(msg)
    const warn = (msg: string) => logger.warn(msg)

    log("🚀 Starting variant-level sales_description migration...")
    log("=".repeat(60))

    // ── 1. Load all variants ──────────────────────────────────────────────────
    let allVariants: any[] = []
    let skip = 0
    while (true) {
        const { data: batch } = await (query as any).graph({
            entity: "product_variant",
            fields: ["id", "sku", "metadata", "product.id", "product.title", "product.metadata"],
            pagination: { skip, take: 500 }
        })
        if (!batch.length) break
        allVariants = allVariants.concat(batch)
        skip += 500
    }

    log(`📦 Total variants: ${allVariants.length}`)

    const alreadyDone = allVariants.filter((v: any) => v.metadata?.sales_description)
    const needsQBSync = allVariants.filter((v: any) => !v.metadata?.sales_description && v.metadata?.quickbooks_id)
    const needsFallback = allVariants.filter((v: any) => !v.metadata?.sales_description && !v.metadata?.quickbooks_id)

    log(`✅ Already have variant sales_description: ${alreadyDone.length}`)
    log(`🔗 Need QB Bridge sync (have quickbooks_id): ${needsQBSync.length}`)
    log(`📋 Need fallback (copy from product):        ${needsFallback.length}`)

    let updatedFromQB = 0
    let updatedFromFallback = 0
    let skippedEmpty = 0
    let errors = 0

    // ── 2. QB Bridge sync ─────────────────────────────────────────────────────
    if (needsQBSync.length > 0) {
        log("\n📡 Fetching from QB Bridge (/api/products/active-with-description)...")

        let qbItems: any[] = []
        try {
            const initRes = await fetch(`${BRIDGE_URL}/api/products/active-with-description`, {
                headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" }
            })

            if (!initRes.ok) {
                warn(`⚠️  Bridge ${initRes.status} — will use fallback only`)
            } else {
                const { operationId } = await initRes.json() as any
                log(`✅ Operation queued: ${operationId}`)

                for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
                    log(`⏳ Polling ${attempt}/${MAX_POLL_ATTEMPTS}...`)
                    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))

                    const statusRes = await fetch(`${BRIDGE_URL}/api/sync/status/${operationId}`, {
                        headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" }
                    })
                    const statusJson = await statusRes.json() as any

                    if (statusJson.operation?.status === "completed") {
                        const qr = statusJson.operation?.result?.QBXML?.QBXMLMsgsRs?.ItemQueryRs
                        const raw = qr?.ItemInventoryRet ?? []
                        qbItems = Array.isArray(raw) ? raw : [raw]
                        log(`✅ Got ${qbItems.length} QB items`)
                        break
                    }
                    if (statusJson.operation?.status === "failed") {
                        warn("⚠️  QB operation failed — skipping QB sync")
                        break
                    }
                }
            }
        } catch (e: any) {
            warn(`⚠️  Bridge unreachable (${e.message}) — skipping QB sync`)
        }

        if (qbItems.length > 0) {
            // ListID → SalesDesc map
            const qbMap = new Map<string, string>()
            for (const item of qbItems) {
                if (item.ListID && item.SalesDesc) {
                    qbMap.set(item.ListID, (item.SalesDesc as string).trim())
                }
            }
            log(`📋 QB items with SalesDesc: ${qbMap.size}`)

            for (const variant of needsQBSync) {
                const qbId = variant.metadata?.quickbooks_id as string
                const salesDesc = qbMap.get(qbId)

                if (!salesDesc) {
                    warn(`   ⚠️  ${variant.sku ?? variant.id}: QB item ${qbId} not found / empty SalesDesc`)
                    skippedEmpty++
                    continue
                }

                try {
                    await productModule.updateProductVariants(variant.id, {
                        metadata: { ...variant.metadata, sales_description: salesDesc }
                    })
                    updatedFromQB++
                    log(`   ✅ ${variant.sku ?? variant.id}: "${salesDesc.substring(0, 80)}${salesDesc.length > 80 ? "..." : ""}"`)
                } catch (e: any) {
                    warn(`   ❌ ${variant.sku ?? variant.id}: ${e.message}`)
                    errors++
                }
            }
        } else {
            warn("⚠️  No QB items — QB sync skipped, falling back for QB-linked variants too")
            // Those variants will be picked up by the fallback below via product.metadata
            for (const variant of needsQBSync) {
                const productSalesDesc: string | undefined = variant.product?.metadata?.sales_description
                if (!productSalesDesc) { skippedEmpty++; continue }
                try {
                    await productModule.updateProductVariants(variant.id, {
                        metadata: { ...variant.metadata, sales_description: productSalesDesc }
                    })
                    updatedFromFallback++
                } catch (e: any) {
                    warn(`   ❌ ${variant.sku ?? variant.id} (QB-fallback): ${e.message}`)
                    errors++
                }
            }
        }
    }

    // ── 3. Fallback: copy product.metadata → variant.metadata ────────────────
    if (needsFallback.length > 0) {
        log(`\n📋 Fallback copy for ${needsFallback.length} variants (no quickbooks_id)...`)
        for (const variant of needsFallback) {
            const productSalesDesc: string | undefined = variant.product?.metadata?.sales_description
            if (!productSalesDesc) { skippedEmpty++; continue }
            try {
                await productModule.updateProductVariants(variant.id, {
                    metadata: { ...variant.metadata, sales_description: productSalesDesc }
                })
                updatedFromFallback++
            } catch (e: any) {
                warn(`   ❌ ${variant.sku ?? variant.id} (fallback): ${e.message}`)
                errors++
            }
        }
        log(`   ✅ Updated from product copy: ${updatedFromFallback}`)
    }

    // ── 4. Summary ────────────────────────────────────────────────────────────
    log(`\n${"=".repeat(60)}`)
    log("✅ VARIANT SALES_DESCRIPTION MIGRATION COMPLETE")
    log("=".repeat(60))
    log(`Already had description:   ${alreadyDone.length}`)
    log(`Updated from QB Bridge:    ${updatedFromQB}`)
    log(`Updated from product copy: ${updatedFromFallback}`)
    log(`Skipped (no description):  ${skippedEmpty}`)
    log(`Errors:                    ${errors}`)
    log("=".repeat(60))
}
