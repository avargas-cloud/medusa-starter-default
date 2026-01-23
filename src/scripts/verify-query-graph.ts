
import { ExecArgs } from "@medusajs/framework/types"

export default async function verifyQueryGraph({ container }: ExecArgs) {
    const query = container.resolve("query")
    const productId = "prod_100w-indoor-meanwell-power-supply-24vdc"

    try {
        console.log("TESTING CONFIRMED ALIAS: attribute_value")
        const { data: products } = await query.graph({
            entity: "product",
            fields: [
                "id",
                "title",
                "attribute_values.*",
                "attribute_values.value",
                "attribute_values.attribute_key.label"
            ],
            filters: {
                id: [productId]
            }
        })

        console.log("📊 Result:")
        if (products.length > 0) {
            const attrs = products[0].attribute_values
            console.log(`   - Linked Attributes Type: ${Array.isArray(attrs) ? 'Array' : typeof attrs}`)
            console.log(`   - Count: ${Array.isArray(attrs) ? attrs.length : '1 (Single Object)'}`)
            console.log("   - Dump:", JSON.stringify(attrs, null, 2))
        }
    } catch (e) {
        console.error("❌ Query Failed:", e)
    }
}
