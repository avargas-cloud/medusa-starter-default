export default async function ({ container }: any) {
    const knex = container.resolve("__pg_connection__")
    const query = container.resolve("query")
    const productId = "prod_ul-freecut-cob-led-strip-single-color-bright-output"

    console.log("🔍 RAW SQL VS QUERY COMPARISON")
    console.log("=".repeat(80))

    // 1. RAW SQL (como hace el GET endpoint)
    const links = await knex("product_product_productattributes_attribute_value")
        .select("attribute_value_id")
        .where("product_id", productId)

    console.log(`\n📊 RAW SQL: Found ${links.length} links`)

    const ids = links.map((l: any) => l.attribute_value_id)

    const { data: attributes } = await query.graph({
        entity: "attribute_value",
        fields: [
            "id",
            "value",
            "attribute_key.id",
            "attribute_key.label",
            "attribute_key.handle",
        ],
        filters: { id: ids }
    })

    console.log(`\n✅ Final attributes returned: ${attributes.length}`)

    const powerConsumption = attributes.filter((a: any) =>
        a.attribute_key.handle === "power-consumption"
    )

    console.log(`\n⚡ Power Consumption values: ${powerConsumption.length}`)
    powerConsumption.forEach((a: any) => {
        console.log(`   - ${a.value} (ID: ${a.id})`)
    })

    console.log("=".repeat(80))
}
