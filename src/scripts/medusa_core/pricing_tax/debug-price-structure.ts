/**
 * Debug Price Structure
 * Shows how prices are actually stored
 */

import { ContainerRegistrationKeys } from "@medusajs/utils"

export default async function debugPriceStructure({ container }: any) {
    const logger = container.resolve("logger")
    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    logger.info("\n🔍 DEBUG: PRICE STRUCTURE\n")

    try {
        // Get a sample variant with all price fields
        const { data: variants } = await query.graph({
            entity: "product_variant",
            fields: [
                "id",
                "sku",
                "title",
                "product.title",
                "prices.id",
                "prices.amount",
                "prices.currency_code",
                "prices.price_list_id",
                "prices.price_set_id"
            ],
            pagination: { take: 3 }
        })

        logger.info(`Found ${variants.length} sample variants:\n`)

        variants.forEach((v: any, i: number) => {
            logger.info(`[${i + 1}] ${v.product?.title || "Unknown"}`)
            logger.info(`  SKU: ${v.sku}`)
            logger.info(`  Prices: ${v.prices?.length || 0}`)

            if (v.prices && v.prices.length > 0) {
                v.prices.forEach((p: any, j: number) => {
                    logger.info(`    [${j + 1}] Amount: $${(p.amount / 100).toFixed(2)} ${p.currency_code}`)
                    logger.info(`        Price List ID: ${p.price_list_id || "null (default)"}`)
                    logger.info(`        Price Set ID: ${p.price_set_id || "null"}`)
                })
            } else {
                logger.info(`    ⚠️  NO PRICES!`)
            }
            logger.info("")
        })

        return { success: true }

    } catch (error: any) {
        logger.error(`❌ Error: ${error.message}`)
        throw error
    }
}
