import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import * as fs from "fs"
import * as path from "path"

export default async function syncQbData({ container, args }: ExecArgs) {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const productModule = container.resolve(Modules.PRODUCT)
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

    // Parse args
    // Usage: SYNC_MODE=[verify|dry-run|run] SYNC_LIMIT=10 yarn medusa exec ./src/scripts/sync-qb-data.ts
    const mode = process.env.SYNC_MODE || args[0] || "verify" // verify, dry-run, run
    const limitArg = args.find(a => a.startsWith("--limit="))
    const limit = process.env.SYNC_LIMIT ? parseInt(process.env.SYNC_LIMIT) : (limitArg ? parseInt(limitArg.split("=")[1]) : Infinity)

    logger.info(`🚀 Starting QuickBooks Sync Script`)
    logger.info(`   Mode: ${mode}`)
    logger.info(`   Limit: ${limit === Infinity ? "All" : limit}`)

    const inputPath = path.resolve(process.cwd(), "sku.csv")
    if (!fs.existsSync(inputPath)) {
        logger.error(`❌ Input file not found: ${inputPath}`)
        return
    }

    // Read and parse raw data
    // Format: SKU,ListID,MPN,SalesPrice,QuantityOnHand
    const rawContent = fs.readFileSync(inputPath, "utf-8")
    // Handle BOM if present
    const cleanContent = rawContent.replace(/^\uFEFF/, '')

    const lines = cleanContent.split("\n").filter(l => l.trim().length > 0)

    // Skip header if it exists
    const startRow = lines[0].includes("ListID") ? 1 : 0
    const dataRows = lines.slice(startRow)

    logger.info(`📂 Loaded ${dataRows.length} rows from sku.csv`)

    // Parsed Items
    interface QBItem {
        sku: string;
        listId: string;
        mpn: string;
    }

    interface FoundItem extends QBItem {
        variantId: string;
        currentMetadata: Record<string, any>;
    }

    const items: QBItem[] = []
    for (const row of dataRows) {
        // Split by comma (simple split, assuming no commas in fields based on sample)
        const parts = row.trim().split(",")
        if (parts.length < 3) continue

        // Data mapping based on provided structure:
        // SKU,ListID,MPN,SalesPrice,QuantityOnHand
        // MG-M100L12DC,80000699...,M100L12DC-AR,112.5,0

        const sku = parts[0].trim()
        const listId = parts[1].trim()
        const mpn = parts[2].trim()

        if (sku && listId) {
            items.push({ sku, listId, mpn })
        }
    }

    // 1. Verify SKUs
    const missingSkus: QBItem[] = []
    const foundItems: FoundItem[] = []

    logger.info(`🔍 Verifying SKUs against Medusa database...`)

    for (const item of items) {
        const { data: variants } = await query.graph({
            entity: "variant",
            fields: ["id", "sku", "metadata"],
            filters: { sku: item.sku }
        })

        if (variants.length === 0) {
            missingSkus.push(item)
        } else {
            foundItems.push({
                ...item,
                variantId: variants[0].id,
                currentMetadata: variants[0].metadata || {}
            })
        }
    }

    // Report Findings
    logger.info("\n📊 Analysis Results:")
    logger.info(`   ✅ Found in Medusa: ${foundItems.length}`)
    logger.info(`   ❌ Missing in Medusa: ${missingSkus.length}`)

    // Write Missing SKUs Report
    if (missingSkus.length > 0) {
        const missingCsv = ["SKU,ListID,MPN"].concat(
            missingSkus.map(i => `${i.sku},${i.listId},${i.mpn}`)
        ).join("\n")
        fs.writeFileSync("missing_skus.csv", missingCsv)
        logger.info(`   📝 Missing SKUs saved to: missing_skus.csv`)
    }

    if (mode === "verify") {
        return
    }

    // Sync Process
    logger.info(`\n🔄 Starting Sync Process (${mode})...`)

    let processed = 0
    let updated = 0

    for (const item of foundItems) {
        if (processed >= limit) break

        const newMetadata = {
            ...item.currentMetadata,
            quickbooks_id: item.listId,
            mpn: item.mpn
        }

        // Check if update is needed
        const needsUpdate =
            item.currentMetadata.quickbooks_id !== item.listId ||
            item.currentMetadata.mpn !== item.mpn

        if (needsUpdate) {
            if (mode === "run") {
                await productModule.updateProductVariants(item.variantId, {
                    metadata: newMetadata
                })
                logger.info(`   ✅ Updated ${item.sku}: QB=${item.listId}, MPN=${item.mpn}`)
            } else {
                logger.info(`   [DRY RUN] Would update ${item.sku}: QB=${item.listId}, MPN=${item.mpn}`)
            }
            updated++
        } else {
            logger.info(`   ⏭️  Skipped ${item.sku} (Already up to date)`)
        }

        processed++
    }

    logger.info(`\n✨ Sync Complete. Updated: ${updated}`)
}
