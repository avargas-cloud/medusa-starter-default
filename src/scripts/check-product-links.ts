import { ExecArgs } from "@medusajs/framework"

export default async function ({ container }: ExecArgs) {
    const knex = container.resolve("__pg_connection__")
    const query = container.resolve("query")

    const PRODUCT_ID = "prod_ul-freecut-cob-led-strip-single-color-bright-output"

    console.log(`\n🔍 CHECKING POWER CONSUMPTION LINKS FOR PRODUCT\n`)
    console.log("=".repeat(80))

    // Get Power Consumption attribute key
    const { data: powerKey } = await query.graph({
        entity: "attribute_key",
        fields: ["id", "handle"],
        filters: { handle: ["power-consumption"] }
    })

    const keyId = powerKey[0].id
    console.log(`Power Consumption Key ID: ${keyId}`)

    // Get all attribute values for this key
    const { data: allValues } = await query.graph({
        entity: "attribute_value",
        fields: ["id", "value"],
        filters: { attribute_key_id: keyId }
    })

    console.log(`\nTotal Power Consumption values in DB: ${allValues.length}`)

    // Get ALL links for this product in the link table
    const allLinks = await knex("product_product_productattributes_attribute_value")
        .where({ product_id: PRODUCT_ID })
        .select("*")

    console.log(`\n📊 Total links for this product: ${allLinks.length}`)

    // Filter for Power Consumption links
    const valueIds = allValues.map(v => v.id)
    const powerLinks = allLinks.filter(l => valueIds.includes(l.attribute_value_id))

    console.log(`\n⚡ Power Consumption links: ${powerLinks.length}`)
    console.log("=".repeat(80))

    // For each link, show the value
    for (const link of powerLinks) {
        const value = allValues.find(v => v.id === link.attribute_value_id)
        console.log(`   - ${value?.value || 'UNKNOWN'} (ID: ${link.attribute_value_id})`)
    }

    console.log("\n" + "=".repeat(80))
    console.log(`\n✅ Expected: 1 link (20W)`)
    console.log(`❌ Found: ${powerLinks.length} links`)
    console.log(`\n⚠️  This product has ${powerLinks.length - 1} ORPHANED links that should be cleaned\n`)
}
