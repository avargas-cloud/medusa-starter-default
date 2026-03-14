#!/usr/bin/env npx tsx
/**
 * List all products with their IDs
 * Usage: npx tsx scripts/debug/list-products.ts [search-term]
 */

const searchTerm = process.argv[2] || ""
const basePath = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000"

async function main() {
    const url = searchTerm
        ? `${basePath}/admin/products?q=${encodeURIComponent(searchTerm)}&limit=50`
        : `${basePath}/admin/products?limit=50`

    const res = await fetch(url)

    if (!res.ok) {
        console.error(`❌ Failed to fetch products: ${res.status}`)
        process.exit(1)
    }

    const { products, count } = await res.json()

    console.log(`\n📦 Products${searchTerm ? ` matching "${searchTerm}"` : ""} (showing ${products.length} of ${count}):`)
    console.log("─".repeat(80))

    for (const p of products) {
        console.log(`\n${p.title}`)
        console.log(`  ID: ${p.id}`)
        console.log(`  Handle: ${p.handle}`)
        console.log(`  Status: ${p.status}`)

        if (p.attribute_values?.length > 0) {
            const powerConsumption = p.attribute_values.find((av: any) =>
                av.attribute_key?.handle === "power-consumption"
            )
            if (powerConsumption) {
                console.log(`  Power: ${powerConsumption.value}`)
            }
        }
    }

    console.log("\n" + "─".repeat(80))
    console.log(`\n✅ Total: ${count} products\n`)
}

main().catch((err) => {
    console.error("❌ Error:", err.message)
    process.exit(1)
})
