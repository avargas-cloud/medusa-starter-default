import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

export default async function verifyMetadata({ container, args }: ExecArgs) {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

    const skuToVerify = args[0] || "MG-M100L12DC"

    logger.info(`🔍 Verifying metadata for SKU: ${skuToVerify}`)

    const { data: variants } = await query.graph({
        entity: "variant",
        fields: ["id", "sku", "metadata"],
        filters: { sku: skuToVerify }
    })

    if (variants.length > 0) {
        logger.info("✅ Variant Found:")
        logger.info(`   SKU: ${variants[0].sku}`)
        logger.info(`   Metadata:`)
        logger.info(JSON.stringify(variants[0].metadata, null, 2))
    } else {
        logger.error(`❌ Variant having SKU ${skuToVerify} NOT found`)
    }
}
