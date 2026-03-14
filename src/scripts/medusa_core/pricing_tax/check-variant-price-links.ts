/**
 * Check Variant→Price Set Links
 */

export default async function checkVariantPriceLinks({ container }: any) {
    const logger = container.resolve("logger")
    const knex = container.resolve("__pg_connection__")

    const log = (msg: string) => {
        console.log(msg)
        logger.info(msg)
    }

    const SKU = "ESPFC4R4N50W0830"

    log(`\n🔍 CHECKING PRICE LINKS FOR SKU: ${SKU}\n`)

    try {
        // 1. Get variant
        const variant = await knex("product_variant")
            .select("*")
            .where("sku", SKU)
            .first()

        if (!variant) {
            log(`❌ Variant not found`)
            return { success: false }
        }

        log(`✅ Variant Found:`)
        log(`   ID: ${variant.id}`)
        log(`   Title: ${variant.title}`)

        // 2. Check if variant has link to price_set
        const link = await knex("product_variant_price_set")
            .select("*")
            .where("variant_id", variant.id)
            .whereNull("deleted_at")
            .first()

        log(`\n🔗 Link Table (product_variant_price_set):`)
        if (link) {
            log(`   ✅ Link EXISTS`)
            log(`   Variant ID: ${link.variant_id}`)
            log(`   Price Set ID: ${link.price_set_id}`)
            log(`   Created: ${link.created_at}`)

            // 3. Get prices from that price_set
            const prices = await knex("price")
                .select("*")
                .where("price_set_id", link.price_set_id)
                .whereNull("deleted_at")

            log(`\n💲 Prices in Price Set:`)
            if (prices.length > 0) {
                prices.forEach((price: any, i: number) => {
                    const label = price.price_list_id ? "WHOLESALE" : "DEFAULT"
                    log(`   [${i + 1}] ${label}: $${price.amount} ${price.currency_code}`)
                    log(`       Price ID: ${price.id}`)
                    log(`       Price List ID: ${price.price_list_id || "null"}`)
                })
            } else {
                log(`   ❌ NO PRICES in price set ${link.price_set_id}`)
            }

        } else {
            log(`   ❌ NO LINK FOUND!`)
            log(`   This variant is NOT linked to any price_set`)
            log(`   This is why Admin UI shows "No records"`)

            // Check if there are price_sets but not linked
            const orphanPriceSets = await knex("price_set")
                .select("*")
                .where("id", 'like', `%${variant.id.substring(8, 20)}%`)
                .limit(5)

            if (orphanPriceSets.length > 0) {
                log(`\n💡 Found potential orphan price sets:`)
                orphanPriceSets.forEach((ps: any) => {
                    log(`     ${ps.id}`)
                })
            }
        }

        // 4. Count how many variants have NO links
        const totalVariants = await knex("product_variant")
            .whereNull("deleted_at")
            .count("* as count")
            .first()

        const linkedVariants = await knex("product_variant_price_set")
            .whereNull("deleted_at")
            .countDistinct("variant_id as count")
            .first()

        log(`\n${"=".repeat(70)}`)
        log("📊 SYSTEM-WIDE ANALYSIS")
        log("=".repeat(70))
        log(`Total Variants: ${totalVariants?.count || 0}`)
        log(`Linked to Price Sets: ${linkedVariants?.count || 0}`)
        log(`Missing Links: ${(totalVariants?.count || 0) - (linkedVariants?.count || 0)}`)
        log("=".repeat(70))

        return { success: true }

    } catch (error: any) {
        log(`❌ Error: ${error.message}`)
        console.error(error.stack)
        throw error
    }
}
