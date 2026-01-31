export default async function ({ container }: any) {
    const query = container.resolve("query")

    console.log("🔍 CATEGORY FILTER VERIFICATION")
    console.log("=".repeat(80))

    // Get WHITE LED STRIPS category
    const { data: categories } = await query.graph({
        entity: "product_category",
        fields: ["id", "handle", "name", "metadata"],
        filters: { handle: "led-strips-white" }
    })

    const category = categories[0]

    if (!category) {
        console.log(`❌ Category not found`)
        return
    }

    console.log(`\n📂 Category: ${category.name}`)
    console.log(`📊 Metadata filters:`)
    console.log(JSON.stringify(category.metadata?.filters || {}, null, 2))

    // Get all published products in this category
    const { data: products } = await query.graph({
        entity: "product",
        fields: ["id", "title", "status", "categories.id"],
        filters: {
            status: "published",
            categories: { id: category.id }
        }
    })

    console.log(`\n📦 Found ${products.length} published products in category`)

    // For each product, get Power Consumption attribute
    for (const product of products) {
        const { data: links } = await query.graph({
            entity: "product_attribute_value",
            fields: ["attribute_value_id"],
            filters: { product_id: product.id }
        })

        const valueIds = links.map((l: any) => l.attribute_value_id)

        const { data: attributes } = await query.graph({
            entity: "attribute_value",
            fields: ["id", "value", "attribute_key.handle"],
            filters: { id: valueIds }
        })

        const powerConsumption = attributes.filter((a: any) =>
            a.attribute_key.handle === "power-consumption"
        )

        if (powerConsumption.length > 0) {
            console.log(`\n   ${product.title}:`)
            powerConsumption.forEach((pc: any) => {
                console.log(`      → ${pc.value}`)
            })
        }
    }

    console.log("\n" + "=".repeat(80))
}
