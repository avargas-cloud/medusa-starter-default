
import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

export default async function verifyForceJoin({ container }: ExecArgs) {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const productId = "prod_100w-indoor-meanwell-power-supply-24vdc"

    console.log("🔍 Attempting to force-fetch 'attribute_value'...")

    try {
        const { data: products } = await query.graph({
            entity: "product",
            fields: [
                "id",
                "title",
                "attribute_value.*",       // <--- We force the join here
                "attribute_value.value"    // We ask for the value specifically
            ],
            filters: {
                id: [productId]
            }
        })

        if (products.length === 0) {
            console.log("❌ Product not found.")
            return
        }

        const product = products[0]
        const attrs = product.attribute_value

        if (attrs) {
            console.log("✅ SUCCESS! Link found via alias 'attribute_value'")
            console.log(`   Type: ${Array.isArray(attrs) ? "Array" : typeof attrs}`)
            console.log(`   Count: ${Array.isArray(attrs) ? attrs.length : "1 (Single Object)"}`)
            console.log("Values:", JSON.stringify(attrs, null, 2))
        } else {
            console.log("❌ Query ran, but returned no attributes under 'attribute_value'. Checking fallback...")

            // Fallback: Try 'product_attributes' alias just in case
            const { data: productsRetry } = await query.graph({
                entity: "product",
                fields: ["id", "product_attributes.*"],
                filters: { id: [product.id] }
            })
            console.log("Retry result (product_attributes):", productsRetry[0]?.product_attributes ?? "undefined")
        }
    } catch (e) {
        console.error("❌ Script Error:", e)
    }
}
