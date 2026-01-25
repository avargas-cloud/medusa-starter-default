/**
 * Create Price Sets for All Variants
 * 
 * WooCommerce import created variants without Price Sets
 * This script creates them before assigning prices
 */

import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

export default async function createPriceSets({ container }: ExecArgs) {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const pricingModule = container.resolve(Modules.PRICING)
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const remoteLink = container.resolve("remoteLink")

    logger.info("🏗️  Creating Price Sets for Variants...")

    try {
        // Get all variants
        const { data: variants } = await query.graph({
            entity: "variant",
            fields: ["id", "sku", "title", "price_set.id"],
        })

        logger.info(`Found ${variants.length} total variants`)

        // Filter variants without price sets
        const variantsNeedingPriceSets = variants.filter((v: any) => !v.price_set?.id)

        logger.info(`${variantsNeedingPriceSets.length} variants need Price Sets`)

        if (variantsNeedingPriceSets.length === 0) {
            logger.info("✅ All variants already have Price Sets!")
            return { success: true, created: 0 }
        }

        let created = 0

        // Create price sets in batches
        const batchSize = 50

        for (let i = 0; i < variantsNeedingPriceSets.length; i += batchSize) {
            const batch = variantsNeedingPriceSets.slice(i, i + batchSize)

            try {
                for (const variant of batch) {
                    // Create price set
                    const [priceSet] = await pricingModule.createPriceSets([
                        {
                            // No rules = default price set
                        }
                    ])

                    // Link price set to variant
                    await remoteLink.create({
                        productService: {
                            variant_id: variant.id,
                        },
                        pricingService: {
                            price_set_id: priceSet.id,
                        },
                    })

                    created++
                }

                logger.info(`  ✓ Created ${created}/${variantsNeedingPriceSets.length} Price Sets...`)

            } catch (error: any) {
                logger.error(`  ✗ Failed for batch: ${error.message}`)
            }
        }

        logger.info("\n" + "=".repeat(60))
        logger.info("✅ PRICE SET CREATION COMPLETE!")
        logger.info("=".repeat(60))
        logger.info(`Created: ${created} Price Sets`)
        logger.info("=".repeat(60))

        logger.info("\n📝 Next Step:")
        logger.info("Run: yarn medusa exec ./src/scripts/assign-placeholder-prices.ts")

        return { success: true, created }

    } catch (error: any) {
        logger.error(`❌ Error: ${error.message}`)
        logger.error(error.stack)
        throw error
    }
}
