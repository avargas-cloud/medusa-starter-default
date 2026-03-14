import { ExecArgs } from "@medusajs/framework/types"

export default async function ({ container }: ExecArgs) {
    const knex = container.resolve("__pg_connection__")
    const query = container.resolve("query")

    console.log("\n🔍 CHECKING ATTRIBUTE LINK STATUS")
    console.log("=".repeat(80))

    const productId = "prod_ul-freecut-cob-led-strip-single-color-bright-output"

    // 1. Get ALL raw links (including soft-deleted)
    const allRawLinks = await knex("product_product_productattributes_attribute_value")
        .where("product_id", productId)
        .orderBy("created_at", "desc")

    console.log(`\n📊 Raw DB Links: ${allRawLinks.length} total`)

    for (const link of allRawLinks) {
        const value = await knex("attribute_value")
            .select("value", "attribute_key_id")
            .where("id", link.attribute_value_id)
            .first()

        const key = await knex("attribute_key")
            .select("handle")
            .where("id", value?.attribute_key_id)
            .first()

        const status = link.deleted_at ? "❌ SOFT-DELETED" : "✅ ACTIVE"
        console.log(`   ${status} ${key?.handle}: ${value?.value}`)
        if (link.deleted_at) {
            console.log(`      Deleted at: ${link.deleted_at}`)
        }
    }

    // 2. Check what the API endpoint returns
    const { data: apiLinks } = await query.graph({
        entity: "product_attribute_value",
        fields: ["attribute_value_id"],
        filters: { product_id: productId }
    })

    console.log(`\n📡 API Query returns: ${apiLinks.length} links`)

    console.log("\n" + "=".repeat(80))
    console.log("\n🎯 EXPECTED:")
    console.log("   - Raw DB should show 34+ links (some soft-deleted)")
    console.log("   - API Query should return only ACTIVE links")
    console.log("\n❓ IF API returns soft-deleted links:")
    console.log("   The query.graph doesn't filter deleted_at automatically")
    console.log()
}
