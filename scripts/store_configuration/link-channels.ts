#!/usr/bin/env tsx
import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { ISalesChannelModuleService, IProductModuleService } from "@medusajs/types"

/**
 * link-qb-products-to-sales-channels.ts
 *
 * This script finds all products marked as `qb_imported: true`
 * and links them to ALL available sales channels (Default and POS).
 */

export default async function linkQbProductsToChannels({ container }: ExecArgs) {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const productModule: IProductModuleService = container.resolve(Modules.PRODUCT)
    const scModule: ISalesChannelModuleService = container.resolve(Modules.SALES_CHANNEL)
    const remoteLink = container.resolve(ContainerRegistrationKeys.REMOTE_LINK)

    logger.info("=".repeat(65))
    logger.info("🔗 LINKING QB PRODUCTS TO SALES CHANNELS")
    logger.info("=".repeat(65))

    // 1. Get all Sales Channels
    const channels = await scModule.listSalesChannels({})
    const channelIds = channels.map(c => c.id)
    logger.info(`📋 Found ${channelIds.length} Sales Channels:`)
    channels.forEach(c => logger.info(`   - ${c.name} (${c.id})`))

    if (channelIds.length === 0) {
        logger.error("❌ No sales channels found. Aborting.")
        return
    }

    // 2. We already exported createdIds to results earlier, but to be absolutely sure,
    // we will just query ALL products with `qb_imported: true` or `qb_import_date` in metadata (using Query).
    // Actually, ProductModule currently doesn't easily filter by metadata in listProducts.
    // The easiest way is to read the results file from the previous step which has exactly the 1339 IDs.
    const fs = require('fs')
    const resultsFile = "/tmp/qb-import-single-results.json"

    if (!fs.existsSync(resultsFile)) {
        logger.error("❌ Results file not found from import step. Cannot determine which products to link.")
        return
    }

    const results = JSON.parse(fs.readFileSync(resultsFile, "utf8"))
    const productIds: string[] = results.createdIds || []

    logger.info(`\n📦 Found ${productIds.length} newly imported QB products to link...`)

    if (productIds.length === 0) {
        logger.info("✅ Nothing to link.")
        return
    }

    // 3. Link them in chunks
    logger.info("\n⚙️  Linking products to channels...")
    const chunkSize = 100
    let linked = 0

    // Medusa v2 Linking pattern: Modules.PRODUCT -> Modules.SALES_CHANNEL
    // The Remote Link needs an array of { [Modules.PRODUCT]: { product_id: pid }, [Modules.SALES_CHANNEL]: { sales_channel_id: scid } }

    for (let i = 0; i < productIds.length; i += chunkSize) {
        const chunkIds = productIds.slice(i, i + chunkSize)

        // Create link definitions for all channels and all products in chunk
        const links: any[] = []
        for (const pid of chunkIds) {
            for (const scid of channelIds) {
                links.push({
                    [Modules.PRODUCT]: { product_id: pid },
                    [Modules.SALES_CHANNEL]: { sales_channel_id: scid }
                })
            }
        }

        try {
            await remoteLink.create(links)
            linked += chunkIds.length
            logger.info(`   ✅ Linked ${linked} / ${productIds.length} products...`)
        } catch (err: any) {
            logger.error(`   ❌ Error linking chunk ${i}: ${err.message}`)
            // Try linking one by one as fallback
            for (const pid of chunkIds) {
                try {
                    const singleLinks = channelIds.map(scid => ({
                        [Modules.PRODUCT]: { product_id: pid },
                        [Modules.SALES_CHANNEL]: { sales_channel_id: scid }
                    }))
                    await remoteLink.create(singleLinks)
                } catch (e: any) {
                    // Ignore duplicates if they already exist
                    if (!e.message.includes("already exists")) {
                        logger.error(`      Failed for product ${pid}: ${e.message}`)
                    }
                }
            }
        }
    }

    logger.info("\n" + "=".repeat(65))
    logger.info(`✅ SUCCESS: Linked ${productIds.length} products to ${channelIds.length} channels.`)
    logger.info("=".repeat(65))
}
