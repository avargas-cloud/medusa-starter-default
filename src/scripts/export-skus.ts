import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import * as fs from "fs"
import * as path from "path"

export default async function exportSkus({ container }: ExecArgs) {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

    logger.info("📦 Exporting SKUs to CSV...")

    const { data: products } = await query.graph({
        entity: "product",
        fields: [
            "title",
            "variants.sku",
            "variants.title"
        ],
    })

    // Header
    const csvRows = ["SKU"]

    let variantCount = 0

    for (const product of products) {
        if (!product.variants) continue

        for (const variant of product.variants) {
            const sku = variant.sku || ""
            if (sku) {
                csvRows.push(`"${sku}"`)
                variantCount++
            }
        }
    }

    const outputContent = csvRows.join("\n")
    const outputPath = path.resolve(process.cwd(), "all_skus.csv")

    fs.writeFileSync(outputPath, outputContent)

    logger.info(`✅ Successfully exported ${variantCount} SKUs from ${products.length} products`)
    logger.info(`📂 File saved to: ${outputPath}`)
}
