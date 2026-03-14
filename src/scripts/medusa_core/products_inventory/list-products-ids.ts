import { ExecArgs } from "@medusajs/framework/types"

export default async function listProducts({ container }: ExecArgs) {
    const query = container.resolve("query")

    console.log("\n📋 LISTING ALL PRODUCTS (showing first 20)...")
    console.log("─".repeat(80))

    const { data: products } = await query.graph({
        entity: "product",
        fields: ["id", "title", "handle"],
        filters: {},
        pagination: { take: 20 }
    })

    if (!products || products.length === 0) {
        console.log("❌ No products found")
        return
    }

    for (const p of products) {
        console.log(`\n📦 ${p.title}`)
        console.log(`   ID: ${p.id}`)
        console.log(`   Handle: ${p.handle}`)
    }

    console.log("\n" + "─".repeat(80))
    console.log(`\n✅ Showing ${products.length} products`)
    console.log(`\n💡 Copy an ID and paste it into verify-product-attrs.ts\n`)
}
