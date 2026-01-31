import { ExecArgs } from "@medusajs/medusa"

export default async function ({ container }: ExecArgs) {
    const query = container.resolve("query")
    const knex = container.resolve("__pg_connection__")

    const CATEGORY_ID = "pcat_led-strips-white"

    console.log(`\n🔍 FIND ORPHANED POWER CONSUMPTION LINKS\n`)
    console.log("=".repeat(80))

    // 1. Get PUBLISHED products in category
    const { data: products } = await query.graph({
        entity: "product",
        fields: ["id", "title", "status"],
        filters: {
            categories: { id: [CATEGORY_ID] },
            status: ["published"]  // ONLY PUBLISHED
        }
    })

    const publishedIds = products.map((p: any) => p.id)

    console.log(`\n📦 PUBLISHED products in ${CATEGORY_ID}: ${products.length}`)
    products.forEach((p: any) => console.log(`   - ${p.title}`))

    // 2. Get Power Consumption key
    const { data: powerKey } = await query.graph({
        entity: "attribute_key",
        fields: ["id"],
        filters: { handle: ["power-consumption"] }
    })

    const keyId = powerKey[0].id

    // 3. Get ALL attribute_value IDs for Power Consumption
    const { data: allValues } = await query.graph({
        entity: "attribute_value",
        fields: ["id", "value"],
        filters: { attribute_key_id: keyId }
    })

    console.log(`\n📊 Total Power Consumption values in DB: ${allValues.length}`)

    // 4. For EACH value, count how many products (ANY status) have links
    console.log(`\n🔗 CHECKING LINKS FOR EACH VALUE:\n`)

    for (const value of allValues) {
        // Get ALL products linked to this value (any status)
        const links = await knex("product_attribute_value")
            .where({ attribute_value_id: value.id })
            .select("product_id")

        if (links.length === 0) continue // Skip unused values

        // Count how many are PUBLISHED
        const publishedLinks = links.filter((l: any) => publishedIds.includes(l.product_id))

        if (publishedLinks.length > 0) {
            console.log(`✅ ${value.value}: ${publishedLinks.length} PUBLISHED product(s)`)
        } else {
            console.log(`⚠️  ${value.value}: ${links.length} link(s) but ALL are DRAFT products`)
        }
    }

    console.log(`\n` + "=".repeat(80))
}
