import { ExecArgs } from "@medusajs/framework/types"

export default async function verifyProductAttrs({ container }: ExecArgs) {
    const query = container.resolve("query")

    // EDIT THIS: Put your product ID here
    const productId = "prod_ul-freecut-cob-led-strip-single-color-bright-output"

    console.log("\n🔍 QUERYING DATABASE DIRECTLY (no cache)...")
    console.log("─".repeat(80))

    const { data: products } = await query.graph({
        entity: "product",
        fields: [
            "id",
            "title",
            "handle",
            "attribute_values.value",
            "attribute_values.attribute_key.label"
        ],
        filters: { id: productId }
    })

    if (!products || products.length === 0) {
        console.error(`❌ Product not found: ${productId}`)
        return
    }

    const product = products[0]

    console.log(`\n📦 ${product.title}`)
    console.log(`   ID: ${product.id}`)
    console.log(`   Handle: ${product.handle}\n`)

    if (!product.attribute_values || product.attribute_values.length === 0) {
        console.log("⚠️  No attributes found\n")
        return
    }

    console.log("🏷️  PRODUCT ATTRIBUTES (from database):")
    console.log("─".repeat(80))

    for (const av of product.attribute_values) {
        console.log(`${av.attribute_key.label}: ${av.value}`)
    }

    console.log("─".repeat(80))
    console.log(`\n✅ Total: ${product.attribute_values.length} attributes\n`)
}
