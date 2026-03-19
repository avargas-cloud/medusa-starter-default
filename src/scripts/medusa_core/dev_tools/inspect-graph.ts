
import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/utils"

export default async function inspectGraph({ container }: ExecArgs) {
    const query = container.resolve("query")
    const productModule = container.resolve(Modules.PRODUCT)

    console.log("🔍 [BACKEND] Inspecting Product Keys...")

    // 1. Get the specific product we migrated
    const productId = "prod_100w-indoor-meanwell-power-supply-24vdc"
    const product = await productModule.retrieveProduct(productId).catch(() => null)

    if (!product) {
        console.log("❌ Target product not found.")
        return
    }

    console.log(`📦 Analyzing Product: ${product.id}`)

    // 2. Query Graph for EVERYTHING on this product
    try {
        const { data: graphProduct } = await query.graph({
            entity: "product",
            fields: ["*"], // fetch all scalars
            filters: { id: product.id }
        })

        console.log("🔑 Scalar Keys:", Object.keys(graphProduct[0]))

        // 3. Test specific link speculations
        const potentialLinks = [
            "product_attributes",
            "attribute_value",
            "attribute_values",
            "attribute",
            "attributes",
            "product_attribute"
        ]

        for (const linkName of potentialLinks) {
            try {
                const { data } = await query.graph({
                    entity: "product",
                    fields: [`${linkName}.*`],
                    filters: { id: product.id }
                })
                const val = data[0][linkName]
                if (val && (Array.isArray(val) ? val.length > 0 : true)) {
                    console.log(`🎉 MATCH FOUND: '${linkName}' ->`, Array.isArray(val) ? `Array(${val.length})` : typeof val)
                } else {
                    console.log(`   (empty): ${linkName}`)
                }
            } catch (err) {
                // console.log(`   (invalid): ${linkName}`) 
            }
        }

    } catch (e) {
        console.error("❌ Error querying graph:", e)
    }
}
