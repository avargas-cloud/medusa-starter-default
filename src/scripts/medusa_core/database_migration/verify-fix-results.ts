import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

/**
 * Verify Product Options Fix - Quick DB Verification
 * 
 * Checks if products have proper Product Options and linked variants
 * 
 * Usage: medusa exec ./src/scripts/verify-fix-results.ts [product_id1] [product_id2] ...
 */
export default async function verifyFixResults(
    { container }: ExecArgs,
    args: string[] = []
) {
    const productService = container.resolve(Modules.PRODUCT)
    const logger = container.resolve("logger")

    // Sample product IDs from the successful run
    const productIds = args.length > 0 ? args : [
        "prod_200w-power-supply-for-led-ac-dimmers-switch-24vdc",
        "prod_200w-waterproof-meanwell-power-supply-24vdc",
        "prod_22-2-awg-stranded-wire"
    ]

    logger.info("🔍 Verifying Product Options Fix...")
    logger.info(`Checking ${productIds.length} products\n`)

    for (const productId of productIds) {
        try {
            const product = await productService.retrieveProduct(productId, {
                relations: ["options", "options.values", "variants", "variants.options"]
            })

            logger.info(`\n📦 Product: ${product.title}`)
            logger.info(`   ID: ${product.id}`)
            logger.info(`   Options: ${product.options?.length || 0}`)

            if (product.options && product.options.length > 0) {
                for (const option of product.options) {
                    logger.info(`   - Option: "${option.title}" (${option.id})`)
                    logger.info(`     Values: ${option.values?.length || 0}`)
                    if (option.values) {
                        for (const value of option.values) {
                            logger.info(`       • ${value.value} (${value.id})`)
                        }
                    }
                }
            } else {
                logger.warn(`   ⚠️  NO OPTIONS FOUND!`)
            }

            logger.info(`   Variants: ${product.variants?.length || 0}`)
            if (product.variants) {
                for (const variant of product.variants) {
                    logger.info(`   - Variant: "${variant.title}" (${variant.id})`)
                    logger.info(`     SKU: ${variant.sku || "N/A"}`)
                    logger.info(`     Linked Options: ${variant.options?.length || 0}`)
                    if (variant.options && variant.options.length > 0) {
                        for (const opt of variant.options) {
                            logger.info(`       • ${opt.option_id} → ${opt.value}`)
                        }
                        logger.info(`     ✅ Variant is linked to option(s)`)
                    } else {
                        logger.error(`     ❌ VARIANT HAS NO LINKED OPTIONS!`)
                    }
                }
            }

        } catch (error: any) {
            logger.error(`❌ Error checking ${productId}: ${error.message}`)
        }
    }

    logger.info("\n" + "=".repeat(80))
    logger.info("✅ Verification complete!")
}
