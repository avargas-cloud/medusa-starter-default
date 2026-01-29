import { Modules } from "@medusajs/framework/utils"

/**
 * Check Product Breadcrumbs Script
 * 
 * Verifies if breadcrumbs were saved correctly for a specific product
 */
export default async function checkProductBreadcrumbs({ container }) {
    const productModule = container.resolve(Modules.PRODUCT)
    const logger = container.resolve("logger")

    const productId = "prod_100w-waterproof-meanwell-power-supply-plastic-24vdc"

    try {
        const product = await productModule.retrieveProduct(productId, {
            select: ["id", "title", "metadata"]
        })

        logger.info("\n=== Product Info ===")
        logger.info(`ID: ${product.id}`)
        logger.info(`Title: ${product.title}`)
        logger.info("\n=== Metadata ===")
        logger.info(JSON.stringify(product.metadata, null, 2))

        if (product.metadata?.main_category_breadcrumbs) {
            logger.info("\n✅ Breadcrumbs Found!")
            logger.info(`Number of levels: ${product.metadata.main_category_breadcrumbs.length}`)
            logger.info("\nBreadcrumb Trail:")
            product.metadata.main_category_breadcrumbs.forEach((crumb, idx) => {
                logger.info(`  ${idx + 1}. ${crumb.name} (${crumb.id})`)
            })
        } else {
            logger.info("\n❌ No breadcrumbs found in metadata")
        }

        if (product.metadata?.primary_category_id) {
            logger.info(`\n📌 Primary Category ID: ${product.metadata.primary_category_id}`)
        } else {
            logger.info("\n⚠️ No primary_category_id set")
        }

    } catch (error) {
        logger.error("Error:", error)
    }
}
