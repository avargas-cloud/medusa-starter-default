/**
 * Quick diagnostic script to check why prices are returning null
 * Checks: price table, product_variant_price_set join, and query structure
 */

import { Modules } from "@medusajs/framework/utils"

export default async function diagnosePrices({ container }: any) {
    const logger = container.resolve("logger")
    const query = container.resolve("query")
    const knex = container.resolve("__pg_connection__")

    logger.info("\n🔍 DIAGNOSING PRICE ISSUE\n")

    try {
        // 1. Check if any prices exist at all
        const allPricesCount = await knex("price")
            .whereNull("deleted_at")
            .count("* as count")

        logger.info(`📊 Total prices in database: ${allPricesCount[0].count}`)

        // 2. Check price_set structure
        const priceSetsCount = await knex("price_set")
            .whereNull("deleted_at")
            .count("* as count")

        logger.info(`📊 Total price_sets: ${priceSetsCount[0].count}`)

        // 3. Check variant-price_set links
        const variantPriceSetCount = await knex("product_variant_price_set")
            .count("* as count")

        logger.info(`📊 Total variant-price_set links: ${variantPriceSetCount[0].count}`)

        // 4. Sample a product and check its prices using the SAME query as the endpoint
        const { data: sampleProducts } = await query.graph({
            entity: "product",
            fields: ["id", "title", "handle", "variants.*"],
            filters: { status: "published" },
            pagination: { take: 1 }
        })

        if (sampleProducts.length === 0) {
            logger.info("❌ No published products found")
            return { success: false }
        }

        const product = sampleProducts[0]
        const variantIds = product.variants.map((v: any) => v.id)

        logger.info(`\n✅ Testing product: "${product.title}"`)
        logger.info(`   Handle: ${product.handle}`)
        logger.info(`   Variants: ${variantIds.length}`)

        // 5. Run the EXACT same price query as the endpoint
        const prices = await knex("price")
            .select("price.amount", "price.currency_code", "product_variant_price_set.variant_id", "price.price_set_id")
            .join("product_variant_price_set", "price.price_set_id", "product_variant_price_set.price_set_id")
            .whereIn("product_variant_price_set.variant_id", variantIds)
            .where("price.currency_code", "usd")
            .whereNull("price.deleted_at")

        logger.info(`\n💰 Price query results: ${prices.length} prices found`)

        if (prices.length === 0) {
            logger.info("\n❌ PROBLEM FOUND: No prices returned by endpoint query!")
            logger.info("\nDebugging further...\n")

            // Check if price_set_id exists in variant
            for (const variantId of variantIds.slice(0, 2)) {
                const variantPriceSet = await knex("product_variant_price_set")
                    .select("*")
                    .where("variant_id", variantId)
                    .first()

                if (!variantPriceSet) {
                    logger.info(`   ❌ Variant ${variantId}: NO price_set link found`)
                    continue
                }

                logger.info(`   ✅ Variant ${variantId}: price_set_id = ${variantPriceSet.price_set_id}`)

                // Check if prices exist for this price_set
                const pricesForSet = await knex("price")
                    .where("price_set_id", variantPriceSet.price_set_id)
                    .whereNull("deleted_at")

                logger.info(`      Prices in this price_set: ${pricesForSet.length}`)
                pricesForSet.forEach((p: any) => {
                    logger.info(`         - $${p.amount} ${p.currency_code} ${p.price_list_id ? '(price list)' : '(default)'}`)
                })
            }
        } else {
            logger.info("\n✅ Price query working correctly!")
            prices.forEach((p: any) => {
                logger.info(`   - Variant ${p.variant_id}: $${p.amount} ${p.currency_code}`)
            })
        }

        return { success: true }

    } catch (error: any) {
        logger.error(`❌ Error: ${error.message}`)
        logger.error(error.stack)
        throw error
    }
}
