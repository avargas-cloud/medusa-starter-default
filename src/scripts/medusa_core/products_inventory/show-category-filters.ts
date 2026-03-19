import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/utils"
import { IProductModuleService } from "@medusajs/framework/types"

export default async function showCategoryFilters({ container, args }: ExecArgs) {
    const categoryId = args[0]

    if (!categoryId) {
        console.error("❌ Usage: npx medusa exec src/scripts/show-category-filters.ts -- [category-id]")
        process.exit(1)
    }

    const productService: IProductModuleService = container.resolve(Modules.PRODUCT)

    console.log("\n🔍 QUERYING DATABASE DIRECTLY (no cache)...")
    console.log("─".repeat(80))

    // Get category with metadata
    const category = await productService.retrieveProductCategory(categoryId)

    if (!category) {
        console.error(`❌ Category not found: ${categoryId}`)
        process.exit(1)
    }

    console.log(`\n📂 ${category.name}`)
    console.log(`   ID: ${category.id}`)
    console.log(`   Handle: ${category.handle}\n`)

    const filters = (category.metadata as any)?.filters || {}

    if (Object.keys(filters).length === 0) {
        console.log("⚠️  No filters configured in metadata\n")
        return
    }

    // Print full JSON
    console.log("📋 METADATA.FILTERS (complete JSON):")
    console.log("─".repeat(80))
    console.log(JSON.stringify(filters, null, 2))
    console.log("─".repeat(80))

    // Print readable list
    console.log("\n🔎 FILTERS SUMMARY:")
    console.log("─".repeat(80))

    for (const [handle, filter] of Object.entries(filters)) {
        const f = filter as any
        console.log(`\n✓ ${f.label} (${handle})`)
        console.log(`  Type: ${f.filter_type || "checkbox"}`)

        if (f.values && f.values.length > 0) {
            console.log(`  Values (${f.values.length}):`)
            for (const v of f.values) {
                console.log(`    • ${v.value} — ${v.count} products`)
            }
        } else {
            console.log(`  Values: (none)`)
        }
    }

    console.log("\n" + "─".repeat(80))
    console.log(`\n✅ Total: ${Object.keys(filters).length} filter groups\n`)
}
