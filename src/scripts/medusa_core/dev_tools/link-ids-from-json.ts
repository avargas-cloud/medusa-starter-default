import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils"
import * as fs from "fs"

export default async function linkIdsFromJson({ container }: ExecArgs) {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const productModule = container.resolve(Modules.PRODUCT)
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

    const QB_DATA_FILE = "/tmp/qb-active-products.json"

    if (!fs.existsSync(QB_DATA_FILE)) {
        logger.error(`❌ QB Data file not found: ${QB_DATA_FILE}`)
        return
    }

    logger.info(`📂 Reading QB Data from: ${QB_DATA_FILE}`)
    const qbData = JSON.parse(fs.readFileSync(QB_DATA_FILE, "utf-8"))

    // Build SKU -> ListId map
    const skuToListId: Record<string, string> = {}
    for (const item of qbData.products) {
        if (item.sku && item.listId) {
            skuToListId[item.sku.trim()] = item.listId
        }
    }

    logger.info(`📊 Found ${Object.keys(skuToListId).length} items in QB Data`)

    // Fetch all variants missing quickbooks_id
    logger.info(`🔍 Finding variants without quickbooks_id...`)

    // Using raw SQL query via Knex to get all variants
    // The previous script used direct pg Client, let's use Medusa query

    // Note: Since we need to update metadata, using the productModule is safer
    // But getting all variants missing metadata via Graph could be slow, let's just get all variants

    const BATCH_SIZE = 500
    let skip = 0
    let hasMore = true
    let totalProcessed = 0
    let totalUpdated = 0

    while (hasMore) {
        const { data: variants } = await query.graph({
            entity: "variant",
            fields: ["id", "sku", "metadata"],
            pagination: { skip, take: BATCH_SIZE }
        })

        if (!variants || variants.length === 0) {
            hasMore = false
            break
        }

        for (const variant of variants) {
            totalProcessed++
            if (!variant.sku) continue

            const meta = (variant.metadata as any) || {}

            if (meta.quickbooks_id) {
                // Already has an ID, skip
                continue
            }

            const masterSku = variant.sku.trim()
            const qbId = skuToListId[masterSku]

            if (qbId) {
                meta.quickbooks_id = qbId
                await productModule.updateProductVariants(variant.id, {
                    metadata: meta
                })
                logger.info(`  ✅ Linked ${masterSku} → ${qbId}`)
                totalUpdated++
            }
        }

        skip += BATCH_SIZE
        logger.info(`   ... processed ${totalProcessed} variants`)
    }

    logger.info("\n" + "=".repeat(50))
    logger.info(`✅ COMPLETE`)
    logger.info(`Total Processed: ${totalProcessed}`)
    logger.info(`Newly Linked:    ${totalUpdated}`)
    logger.info("=".repeat(50))
}
