/**
 * Debug: Show all prices for a SKU
 * Usage: yarn medusa exec ./src/scripts/debug/debug-prices-sku.ts
 */
import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

const TARGET_SKU_PREFIX = process.env.SKU_PREFIX || "ESPFC4R4N50W08"

export default async function debugPricesSku({ container }: ExecArgs) {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

    const { data: variants } = await query.graph({
        entity: "product_variant",
        fields: [
            "id",
            "sku",
            "prices.id",
            "prices.amount",
            "prices.currency_code",
            "prices.price_list_id",
            "prices.min_quantity",
            "prices.max_quantity",
        ],
        filters: {}
    })

    const matches = variants.filter((v: any) =>
        v.sku?.startsWith(TARGET_SKU_PREFIX)
    )

    for (const v of matches) {
        logger.info(`\n--- SKU: ${v.sku} (variant_id: ${v.id}) ---`)
        logger.info(`  Prices count: ${v.prices?.length || 0}`)
        for (const p of (v.prices || [])) {
            logger.info(`  [${p.id}] $${p.amount} ${p.currency_code} | price_list_id: ${p.price_list_id || 'NULL (retail)'} | qty: ${p.min_quantity}-${p.max_quantity}`)
        }
    }
}
