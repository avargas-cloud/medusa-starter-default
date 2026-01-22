
import { ExecArgs } from "@medusajs/framework/types"

export default async function discoverProductKeys({ container }: ExecArgs) {
    const query = container.resolve("query")
    const productId = "prod_100w-indoor-meanwell-power-supply-24vdc"

    console.log(`🔍 DISCOVERING KEYS for ${productId}...`)

    try {
        // Fetch root product with all default fields
        const { data: productData } = await query.graph({
            entity: "product",
            fields: ["*"],
            filters: { id: productId }
        })

        if (productData.length > 0) {
            const product = productData[0]
            console.log("🔑 Available Keys on Product:")
            console.log(Object.keys(product).sort().join("\n"))

            // Also try to inspect if there are hidden non-enumerable properties or symbols?
            // Usually not necessary for JSON output.
        } else {
            console.log("❌ Product not found.")
        }

    } catch (e) {
        console.error("❌ Discovery Failed:", e)
    }
}
