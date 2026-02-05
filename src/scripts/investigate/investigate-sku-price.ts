/**
 * Investigate price discrepancy for EPS-MDA-60-24
 */

export default async function investigateSKUPrice({ container }: any) {
    const logger = container.resolve("logger")
    const query = container.resolve("query")
    const knex = container.resolve("__pg_connection__")

    const SKU = "EPS-MDA-60-24"

    const log = (msg: string) => {
        console.log(msg)
        logger.info(msg)
    }

    log(`\n🔍 INVESTIGATING PRICE FOR SKU: ${SKU}\n`)

    try {
        // 1. Get variant from database
        const variant = await knex("product_variant")
            .select("*")
            .where("sku", SKU)
            .first()

        if (!variant) {
            log(`❌ Variant not found`)
            return { success: false }
        }

        log(`✅ Variant ID: ${variant.id}`)
        log(`   Title: ${variant.title}`)

        // 2. Get price_set link
        const link = await knex("product_variant_price_set")
            .select("*")
            .where("variant_id", variant.id)
            .whereNull("deleted_at")
            .first()

        if (!link) {
            log(`❌ No price_set link`)
            return { success: false }
        }

        log(`✅ Price Set ID: ${link.price_set_id}`)

        // 3. Get ALL prices from database
        const prices = await knex("price")
            .select("*")
            .where("price_set_id", link.price_set_id)
            .whereNull("deleted_at")
            .orderBy("created_at", "desc")

        log(`\n📊 ALL PRICES IN DATABASE:`)
        prices.forEach((price: any, i: number) => {
            log(`   [${i + 1}] $${price.amount} ${price.currency_code}`)
            log(`       Price ID: ${price.id}`)
            log(`       Price List ID: ${price.price_list_id || "null (default)"}`)
            log(`       Created: ${price.created_at}`)
        })

        // 4. Check via query.graph (what Admin UI uses)
        const { data: variantsGraph } = await query.graph({
            entity: "product_variant",
            fields: [
                "id",
                "sku",
                "prices.id",
                "prices.amount",
                "prices.currency_code",
                "prices.price_list_id",
                "prices.created_at"
            ],
            filters: { sku: SKU }
        })

        log(`\n📊 PRICES VIA QUERY.GRAPH (Admin UI method):`)
        if (variantsGraph?.[0]?.prices) {
            variantsGraph[0].prices.forEach((price: any, i: number) => {
                log(`   [${i + 1}] $${price.amount} ${price.currency_code}`)
                log(`       Created: ${price.created_at}`)
            })
        }

        // 5. Check via inventory_item join (what inventory-advanced might use)
        const invQuery = await knex("inventory_item as ii")
            .select(
                "ii.sku",
                "pv.id as variant_id",
                "p.amount",
                "p.currency_code",
                "p.id as price_id"
            )
            .leftJoin("inventory_level_product_variant as ilvp", "ii.id", "ilvp.inventory_item_id")
            .leftJoin("product_variant as pv", "ilvp.variant_id", "pv.id")
            .leftJoin("product_variant_price_set as pvps", "pv.id", "pvps.variant_id")
            .leftJoin("price as p", function () {
                this.on("pvps.price_set_id", "=", "p.price_set_id")
                    .andOnNull("p.deleted_at")
            })
            .where("ii.sku", SKU)
            .whereNull("pvps.deleted_at")

        log(`\n📊 PRICES VIA INVENTORY_ITEM JOIN:`)
        invQuery.forEach((row: any, i: number) => {
            log(`   [${i + 1}] $${row.amount} ${row.currency_code}`)
            log(`       Price ID: ${row.price_id}`)
        })

        log(`\n${"=".repeat(70)}`)
        log("📝 SUMMARY")
        log("=".repeat(70))
        log(`Total prices in database: ${prices.length}`)
        log(`Default prices: ${prices.filter((p: any) => !p.price_list_id).length}`)

        const defaultPrice = prices.find((p: any) => !p.price_list_id)
        if (defaultPrice) {
            log(`\n✅ CORRECT PRICE (DEFAULT): $${defaultPrice.amount}`)
        }

        log("=".repeat(70))
        log(`\nExpected in Storefront: $45.25`)
        log(`Actual in Inventory-Advanced: $34.99`)

        if (defaultPrice) {
            if (defaultPrice.amount === 45.25) {
                log(`✅ Database has CORRECT price`)
            } else if (defaultPrice.amount === 34.99) {
                log(`❌ Database has WRONG price (inventory-advanced is correct)`)
            } else {
                log(`⚠️  Database has DIFFERENT price: $${defaultPrice.amount}`)
            }
        }
        log("=".repeat(70))

        return { success: true }

    } catch (error: any) {
        log(`❌ Error: ${error.message}`)
        console.error(error.stack)
        throw error
    }
}
