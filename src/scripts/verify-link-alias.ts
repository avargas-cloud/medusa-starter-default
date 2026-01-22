
import { ExecArgs } from "@medusajs/framework/types"

export default async function verifyLinkAlias({ container }: ExecArgs) {
    const query = container.resolve("query")
    const productId = "prod_100w-indoor-meanwell-power-supply-24vdc"

    console.log(`🔍 Testing Alias 'product_attributes' for ${productId}...`)

    try {
        const { data: productData } = await query.graph({
            entity: "product",
            fields: [
                "id",
                "product_attributes.*"
            ],
            filters: {
                id: productId
            }
        })

        console.log("📊 Query Result:")
        if (productData.length > 0) {
            const prod = productData[0] as any
            const attrs = prod.product_attributes

            console.log(`   - 'product_attributes' exists? ${!!attrs}`)
            if (attrs) {
                console.log(`   - Type: ${typeof attrs}`)
                console.log(`   - Is Array? ${Array.isArray(attrs)}`)
                console.log("   - Dump:", JSON.stringify(attrs, null, 2))
            } else {
                console.log("   - Field is undefined.")
            }
        }
    } catch (e) {
        console.log("❌ Query Failed (Invalid Alias likely):", (e as Error).message)
    }
}
