import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import * as fs from "fs"
import * as path from "path"

export default async function compareSkus({ container }: ExecArgs) {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

    const allSkusPath = path.resolve(process.cwd(), "all_skus.csv")
    const qbSkusPath = path.resolve(process.cwd(), "sku.csv")

    if (!fs.existsSync(allSkusPath) || !fs.existsSync(qbSkusPath)) {
        logger.error("❌ One or both input files not found")
        return
    }

    // Load Medusa SKUs (all_skus.csv)
    const medusaContent = fs.readFileSync(allSkusPath, "utf-8")
    const medusaLines = medusaContent.split("\n").filter(l => l.trim().length > 0)
    // Skip header if 'SKU' is first line
    const medusaData = medusaLines[0].includes("SKU") ? medusaLines.slice(1) : medusaLines

    const medusaSkus = new Set<string>()
    for (const line of medusaData) {
        // Remove quotes and whitespace
        const sku = line.replace(/^"|"$/g, '').trim()
        if (sku) medusaSkus.add(sku)
    }

    logger.info(`📦 Medusa Total SKUs: ${medusaSkus.size}`)

    // Load QB SKUs (sku.csv)
    const qbContent = fs.readFileSync(qbSkusPath, "utf-8")
    // Remove BOM
    const qbCleanContent = qbContent.replace(/^\uFEFF/, '')
    const qbLines = qbCleanContent.split("\n").filter(l => l.trim().length > 0)
    // Skip header
    const qbData = qbLines[0].toLowerCase().includes("sku") ? qbLines.slice(1) : qbLines

    const qbSkus = new Set<string>()
    for (const line of qbData) {
        const parts = line.split(",")
        if (parts.length > 0) {
            const sku = parts[0].trim()
            if (sku) qbSkus.add(sku)
        }
    }

    logger.info(`📘 QuickBooks File SKUs: ${qbSkus.size}`)

    // Compare
    const missingInQb: string[] = []

    for (const sku of medusaSkus) {
        if (!qbSkus.has(sku)) {
            missingInQb.push(sku)
        }
    }

    logger.info("\n📊 Comparison Result:")
    logger.info(`   ❌ SKUs in Medusa but MISSING in QuickBooks file: ${missingInQb.length}`)

    if (missingInQb.length > 0) {
        const outputPath = path.resolve(process.cwd(), "medusa_products_missing_in_qb.csv")
        fs.writeFileSync(outputPath, "SKU\n" + missingInQb.map(s => `"${s}"`).join("\n"))
        logger.info(`   📝 Saved missing list to: ${outputPath}`)

        // Print first 10
        logger.info("\n👀 First 10 missing SKUs:")
        missingInQb.slice(0, 10).forEach(s => logger.info(`   - ${s}`))
    } else {
        logger.info("   ✅ All Medusa SKUs are present in the QuickBooks file!")
    }
}
