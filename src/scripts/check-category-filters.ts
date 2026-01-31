import { MedusaAppLoader, Modules } from "@medusajs/framework"

const categoryId = process.argv[2]

if (!categoryId) {
    console.error("❌ Usage: node dist/scripts/check-category-filters.js [category-id]")
    process.exit(1)
}

async function main() {
    const { medusaApp } = await MedusaAppLoader.load({
        directory: process.cwd()
    })
    const productModuleService = medusaApp.modules[Modules.PRODUCT] as any

    // Get category with metadata
    const category = await productModuleService.retrieveProductCategory(categoryId)

    if (!category) {
        console.error(`❌ Category not found: ${categoryId}`)
        process.exit(1)
    }

    console.log(`\n📂 ${category.name}`)
    console.log(`   ID: ${category.id}`)
    console.log(`   Handle: ${category.handle}\n`)

    const filters = category.metadata?.filters || {}

    if (Object.keys(filters).length === 0) {
        console.log("⚠️  No filters configured in metadata\n")
        process.exit(0)
    }

    // Print full JSON
    console.log("📋 METADATA.FILTERS (JSON):")
    console.log("─".repeat(80))
    console.log(JSON.stringify(filters, null, 2))
    console.log("─".repeat(80))

    // Print readable list
    console.log("\n🔎 FILTERS LIST:")
    console.log("─".repeat(80))

    for (const [handle, filter] of Object.entries(filters)) {
        const f = filter as any
        console.log(`\n${f.label} (${handle})`)
        console.log(`  Type: ${f.filter_type || "checkbox"}`)

        if (f.values && f.values.length > 0) {
            console.log(`  Values (${f.values.length}):`)
            for (const v of f.values) {
                console.log(`    - ${v.value} (${v.count} products)`)
            }
        } else {
            console.log(`  Values: (none)`)
        }
    }

    console.log("\n" + "─".repeat(80))
    console.log(`\n✅ Total: ${Object.keys(filters).length} filter groups\n`)

    process.exit(0)
}

main().catch((err) => {
    console.error("❌ Error:", err.message)
    process.exit(1)
})
