import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

export default async function checkPrice({ container }: ExecArgs) {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

    const sku = "ESPFC4R4N50W0840"

    logger.info(`🔍 Checking price for SKU: ${sku}`)

    const { data: variants } = await query.graph({
        entity: "variant",
        fields: [
            "id",
            "sku",
            "title",
            "price_set.id",
            "price_set.prices.id",
            "price_set.prices.amount",
            "price_set.prices.currency_code"
        ],
        filters: { sku }
    })

    if (variants.length === 0) {
        logger.error("❌ Variant not found")
        return
    }

    const variant = variants[0]
    const prices = variant.price_set?.prices || []
    const usdPrice = prices.find((p: any) => p.currency_code === "usd")

    logger.info(`\n📊 PRICE ANALYSIS FOR ${sku}`)
    logger.info(`${"=".repeat(50)}`)
    logger.info(`Variant ID: ${variant.id}`)
    logger.info(`Title: ${variant.title}`)
    logger.info(`Price Set ID: ${variant.price_set?.id}`)
    logger.info(`\nPRICE DATA:`)
    logger.info(`  Amount (cents): ${usdPrice?.amount}`)
    logger.info(`  Amount (dollars): $${(usdPrice?.amount / 100).toFixed(2)}`)
    logger.info(`\nEXPECTED VALUES:`)
    logger.info(`  If correct: 5675 cents = $56.75`)
    logger.info(`  If wrong (×100): 567500 cents = $5,675.00`)
    logger.info(`${"=".repeat(50)}\n`)
}
