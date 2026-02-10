/**
 * Check specific product that's showing "Price unavailable"
 */

import { Modules } from "@medusajs/framework/utils"

export default async function checkSpecificProduct({ container }: any) {
    const logger = container.resolve("logger")
    const query = container.resolve("query")
    const knex = container.resolve("__pg_connection__")

    const HANDLE = "ul-freecut-cob-led-strip-single-color-bright-output"

    logger.info(`\n🔍 CHECKING PRODUCT: ${HANDLE}\n`)

    try {
        // 1. Get product
        const { data: products } = await query.graph({
            entity: "product",
            fields: ["id", "title", "handle", "variants.*"],
            filters: { handle: HANDLE }
        })

        if (products.length === 0) {
            logger.info("❌ Product not found")
            return { success: false }
        }

        const product = products[0]
        logger.info(`✅ Found: "${product.title}"`)
        logger.info(`   Variants: ${product.variants.length}`)

        // 2. Check each variant
        for (const variant of product.variants.slice(0, 3)) {
            logger.info(`\n📦 Variant: ${variant.title}`)
            logger.info(`   SKU: ${variant.sku || 'NO SKU'}`)
            logger.info(`   ID: ${variant.id}`)

            // Check price_set link
            const priceSetLink = await knex("product_variant_price_set")
                .where("variant_id", variant.id)
                .first()

            if (!priceSetLink) {
                logger.info(`   ❌ NO PRICE_SET LINK FOUND!`)
                logger.info(`   → This variant has NO connection to any price_set`)
                logger.info(`   → This is why calculated_price is null`)
                continue
            }

            logger.info(`   ✅ price_set_id: ${priceSetLink.price_set_id}`)

            // Check prices
            const prices = await knex("price")
                .where("price_set_id", priceSetLink.price_set_id)
                .whereNull("deleted_at")

            logger.info(`   💰 Prices in this price_set: ${prices.length}`)
            prices.forEach((p: any) => {
                logger.info(`      - $${p.amount} ${p.currency_code} ${p.price_list_id ? '(wholesale)' : '(default)'}`)
            })

            if (prices.length === 0) {
                logger.info(`   ⚠️  Price set exists but has NO prices!`)
            }
        }

        return { success: true }

    } catch (error: any) {
        logger.error(`❌ Error: ${error.message}`)
        throw error
    }
}
