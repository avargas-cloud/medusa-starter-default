import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import * as fs from "fs"
import * as path from "path"

export default async function assignQuickBooksIds({ container }: ExecArgs) {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const productModule = container.resolve(Modules.PRODUCT)
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

    // CSV Path - defaults to 'quickbooks_import.csv' in project root
    const csvFileName = "quickbooks_import.csv"
    const csvPath = path.resolve(process.cwd(), csvFileName)

    if (!fs.existsSync(csvPath)) {
        logger.error(`❌ File not found: ${csvPath}`)
        logger.info(`Please create a CSV file named '${csvFileName}' with columns: SKU, QuickBooksID, MPN`)
        logger.info(`Example:`)
        logger.info(`SKU,QuickBooksID,MPN`)
        logger.info(`PROD-001,8000001-1234,MANUFACTURER-PART-1`)
        return
    }

    logger.info(`📂 Reading CSV: ${csvPath}`)
    const content = fs.readFileSync(csvPath, "utf-8")
    const lines = content.split("\n").filter(l => l.trim().length > 0)

    // Skip header
    const dataRows = lines.slice(1)

    logger.info(`📊 Found ${dataRows.length} rows to process`)

    let updatedCount = 0
    let skippedCount = 0
    let errorCount = 0

    for (const row of lines) {
        // Basic CSV parsing provided inputs don't have commas in fields
        // Assuming format: SKU,QuickBooksID,MPN
        // Handle optional quotes
        const cols = row.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g) || []
        const cleanCols = cols.map(c => c.replace(/^"|"$/g, '').trim())

        if (cleanCols.length < 2) continue // Skip empty or invalid lines

        const sku = cleanCols[0]
        // Skip header row if it wasn't filtered
        if (sku.toLowerCase() === 'sku') continue

        // Safety check
        if (!sku) continue

        const qbId = cleanCols[1]
        // Optional MPN (might not be in every row or column might be missing)
        const mpn = cleanCols[2]

        try {
            // Find variant by SKU
            const { data: variants } = await query.graph({
                entity: "variant",
                fields: ["id", "sku", "metadata"],
                filters: { sku: sku }
            })

            if (variants.length === 0) {
                logger.warn(`  ⚠️ SKU not found: ${sku}`)
                skippedCount++
                continue
            }

            const variant = variants[0]
            const currentMetadata = variant.metadata || {}

            const newMetadata = {
                ...currentMetadata,
            }

            let changes = false
            if (qbId && qbId !== 'undefined' && qbId !== 'null') {
                newMetadata['quickbooks_id'] = qbId
                changes = true
            }

            if (mpn && mpn !== 'undefined' && mpn !== 'null') {
                newMetadata['mpn'] = mpn
                changes = true
            }

            if (changes) {
                await productModule.updateProductVariants(variant.id, {
                    metadata: newMetadata
                })
                logger.info(`  ✅ Updated ${sku}: QB_ID=${qbId || 'N/A'}, MPN=${mpn || 'N/A'}`)
                updatedCount++
            } else {
                logger.info(`  Example row ${sku} had no valid data to update`)
                skippedCount++
            }

        } catch (e: any) {
            logger.error(`  ❌ Error processing ${sku}: ${e.message}`)
            errorCount++
        }
    }

    logger.info("\n" + "=".repeat(50))
    logger.info(`✅ COMPLETE`)
    logger.info(`Updated: ${updatedCount}`)
    logger.info(`Skipped/Not Found: ${skippedCount}`)
    logger.info(`Errors: ${errorCount}`)
    logger.info("=".repeat(50))
}
