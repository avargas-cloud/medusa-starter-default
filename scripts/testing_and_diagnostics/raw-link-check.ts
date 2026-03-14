import { ExecArgs } from "@medusajs/framework/types"

export default async function ({ container }: ExecArgs) {
    const knex = container.resolve("__pg_connection__")

    console.log("\n🔍 RAW DB QUERY - Power Consumption Links")
    console.log("=" * 80)

    const productId = "prod_ul-freecut-cob-led-strip-single-color-bright-output"
    const powerConsumptionKeyId = "01KFK5WE9Q1AB9QR7GFVS5MAD7"

    // Query the link table directly
    const links = await knex("product_product_productattributes_attribute_value")
        .select("*")
        .where("product_id", productId)
        .whereIn("attribute_value_id", function () {
            this.select("id")
                .from("attribute_value")
                .where("attribute_key_id", powerConsumptionKeyId)
        })

    console.log(`\nFound ${links.length} Power Consumption links in link table:`)

    for (const link of links) {
        // Get the value details
        const value = await knex("attribute_value")
            .select("value")
            .where("id", link.attribute_value_id)
            .first()

        console.log(`   - ${value.value} (value_id: ${link.attribute_value_id})`)
        console.log(`     deleted_at: ${link.deleted_at || "NULL"}`)
    }

    console.log("\n" + "=".repeat(80) + "\n")
}
