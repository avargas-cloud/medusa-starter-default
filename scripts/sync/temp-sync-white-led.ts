import { Modules } from "@medusajs/framework/utils"
import { initialize } from "@medusajs/framework"

async function main() {
    const { container } = await initialize()
    const query = container.resolve("query")
    const productModuleService = container.resolve(Modules.PRODUCT)

    // Find " White LED Strips" category
    const { data: categories } = await query.graph({
        entity: "product_category",
        fields: ["id", "name", "handle"],
        filters: { handle: "led-strips-white" }
    })

    if (categories.length === 0) {
        console.error("❌ Category 'led-strips-white' not found")
        process.exit(1)
    }

    const category = categories[0]
    console.log(`\n🔄 Syncing category: ${category.name} (${category.id})`)

    // Get products in this category (including children)
    const { data: productCategories } = await query.graph({
        entity: "product_category",
        fields: ["id", "product_category_products.product_id"],
        filters: {
            $or: [
                { id: category.id },
                { parent_category_id: category.id }
            ]
        }
    })

    const productIds = new Set<string>()
    for (const pc of productCategories) {
        for (const pcp of pc.product_category_products || []) {
            productIds.add(pcp.product_id)
        }
    }

    console.log(`   Found ${productIds.size} products`)

    // Get all attributes for these products
    const { data: links } = await query.graph({
        entity: "product_attribute_value",
        fields: ["product_id", "attribute_value_id"],
        filters: { product_id: Array.from(productIds) }
    })

    const attributeIds = [...new Set(links.map((l: any) => l.attribute_value_id))]

    const { data: attributes } = await query.graph({
        entity: "attribute_value",
        fields: [
            "id",
            "value",
            "attribute_key.id",
            "attribute_key.handle",
            "attribute_key.label",
            "attribute_key.filter_type"
        ],
        filters: { id: attributeIds }
    })

    // Group by key
    const groupedByKey = new Map<string, any[]>()
    for (const attr of attributes as any[]) {
        const key = attr.attribute_key
        if (!groupedByKey.has(key.handle)) {
            groupedByKey.set(key.handle, [])
        }
        groupedByKey.get(key.handle)!.push({
            value: attr.value,
            count: links.filter((l: any) => l.attribute_value_id === attr.id).length
        })
    }

    // Build filters object
    const filters: any = {}
    for (const [handle, values] of groupedByKey) {
        const key = (attributes as any[]).find(a => a.attribute_key.handle === handle)?.attribute_key
        if (!key) continue

        // Aggregate counts
        const valueMap = new Map<string, number>()
        for (const v of values) {
            valueMap.set(v.value, (valueMap.get(v.value) || 0) + v.count)
        }

        filters[handle] = {
            label: key.label,
            filter_type: key.filter_type || "checkbox",
            values: Array.from(valueMap.entries()).map(([value, count]) => ({
                value,
                count
            })).sort((a, b) => a.value.localeCompare(b.value))
        }
    }

    console.log(`\n📊 Power Consumption filter:`)
    console.log(JSON.stringify(filters["power-consumption"], null, 2))

    // Update category metadata
    await productModuleService.updateProductCategories(category.id, {
        metadata: {
            filters: filters
        }
    })

    console.log(`\n✅ Updated category metadata with ${Object.keys(filters).length} filter groups`)
    await container.dispose()
    process.exit(0)
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
