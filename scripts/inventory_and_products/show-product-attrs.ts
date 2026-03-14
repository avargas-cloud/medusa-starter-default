import { ExecArgs } from "@medusajs/framework/types"

export default async function showProductAttributes({ container, args }: ExecArgs) {
    const productId = args[0]

    if (!productId) {
        console.error("❌ Usage: npx medusa exec src/scripts/show-product-attrs.ts -- [product-id]")
        process.exit(1)
    }

    const query = container.resolve("query") as any

    console.log("\n🔍 QUERYING DATABASE DIRECTLY (no cache)...")
    console.log("─".repeat(80))

    // Get product with attributes
    const { data: products } = await query.graph({
        entity: "product",
        fields: [
            "id",
            "title",
            "handle",
            "attribute_values.id",
            "attribute_values.value",
            "attribute_values.attribute_key.label",
            "attribute_values.attribute_key.handle"
        ],
        filters: { id: productId }
    })

    if (!products || products.length === 0) {
        console.error(`❌ Product not found: ${productId}`)
        process.exit(1)
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
