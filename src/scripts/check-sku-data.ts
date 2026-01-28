import { ExecArgs } from "@medusajs/framework/types"
import { meiliClient, PRODUCTS_INDEX } from "../lib/meili-backend"

export default async function ({ container }: ExecArgs) {
    console.log("🔍 Checking product SKU data in MeiliSearch...")

    const index = meiliClient.index(PRODUCTS_INDEX)

    // Get first product to inspect
    const result = await index.getDocuments({
        limit: 1,
    })

    if (result.results.length > 0) {
        const product = result.results[0]
        console.log("\n📦 Sample Product:")
        console.log("ID:", product.id)
        console.log("Title:", product.title)
        console.log("variant_sku:", product.variant_sku)
        console.log("variant_sku type:", typeof product.variant_sku)
        console.log("variant_sku length:", product.variant_sku?.length)
        console.log("\n Full product data:")
        console.log(JSON.stringify(product, null, 2))
    }
}
