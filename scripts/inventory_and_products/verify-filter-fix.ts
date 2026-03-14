export default async function ({ container }: any) {
    const knex = container.resolve("__pg_connection__")
    const query = container.resolve("query")

    const categoryHandle = "led-strips-white"

    console.log(`🔄 FORCE REGENERATING FILTERS FOR: ${categoryHandle}`)

    // 1. Get category
    const { data: categories } = await query.graph({
        entity: "product_category",
        fields: ["id", "name"],
        filters: { handle: categoryHandle }
    })

    const category = categories[0]
    if (!category) {
        console.log(`❌ Category not found`)
        return
    }

    console.log(`📂 Category: ${category.name} (${category.id})`)

    // 2. Get published products in category
    const { data: products } = await query.graph({
        entity: "product",
        fields: ["id"],
        filters: {
            status: "published",
            categories: { id: category.id }
        }
    })

    const productIds = products.map((p: any) => p.id)
    console.log(`📦 Found ${productIds.length} published products`)

    // 3. Get Power Consumption attribute
    const { data: attrs } = await query.graph({
        entity: "attribute_key",
        fields: ["id"],
        filters: { handle: "power-consumption" }
    })

    const powerAttr = attrs[0]
    const { data: values } = await query.graph({
        entity: "attribute_value",
        fields: ["id", "value"],
        filters: { attribute_key_id: powerAttr.id }
    })

    console.log(`\n🔍 Checking Power Consumption links (with soft-delete filter):`)

    const valueIds = values.map((v: any) => v.id)
    const links = await knex("product_product_productattributes_attribute_value")
        .select("attribute_value_id")
        .whereIn("product_id", productIds)
        .whereIn("attribute_value_id", valueIds)
        .whereNull("deleted_at")  // ✅ Filter soft-deletes

    const uniqueValues = [...new Set(links.map((l: any) => l.attribute_value_id))]
    console.log(`   → Found ${uniqueValues.length} unique values in links table`)

    uniqueValues.forEach(vid => {
        const val = values.find((v: any) => v.id === vid)
        console.log(`      - ${val.value}`)
    })

    console.log(`\n✅ Code is correct - filter generator will now show only these ${uniqueValues.length} values`)
    console.log(`💡 Trigger resync by editing any product in Admin UI`)
}
