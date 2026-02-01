import { ExecArgs } from "@medusajs/framework/types"
import { generateFiltersForCategory } from "../api/admin/product-categories/[id]/generate-filters/generator"

export default async function ({ container }: ExecArgs) {
    const query = container.resolve("query") as any
    const knex = container.resolve("__pg_connection__") as any

    console.log("\n🔄 MASS FILTER SYNC - ALL CATEGORIES")
    console.log("=".repeat(80))

    // 1. Get all categories with filter_config
    const { data: allCategories } = await query.graph({
        entity: "product_category",
        fields: ["id", "handle", "name", "metadata"],
        filters: {}
    })

    const categoriesWithFilters = allCategories.filter((cat: any) =>
        cat.metadata?.filter_config?.active_filters?.length > 0
    )

    console.log(`\n📂 Found ${categoriesWithFilters.length} categories with configured filters`)
    console.log(`   (out of ${allCategories.length} total categories)`)

    if (categoriesWithFilters.length === 0) {
        console.log("\n⚠️  No categories have filter configurations")
        return
    }

    let successCount = 0
    let errorCount = 0

    // 2. Regenerate filters for each category
    for (const category of categoriesWithFilters) {
        console.log(`\n🔄 [${successCount + errorCount + 1}/${categoriesWithFilters.length}] ${category.name}`)

        try {
            const filterConfig = category.metadata.filter_config

            // Handle both old (string[]) and new (object[]) formats
            let activeFilterIds: string[] = []

            if (Array.isArray(filterConfig.active_filters) && filterConfig.active_filters.length > 0) {
                const first = filterConfig.active_filters[0]
                if (typeof first === "string") {
                    // Old format: ["attr_id_1", "attr_id_2"]
                    activeFilterIds = filterConfig.active_filters
                } else if (typeof first === "object" && first?.attribute_id) {
                    // New format: [{attribute_id: "...", order: 0}]
                    activeFilterIds = filterConfig.active_filters.map((f: any) => f.attribute_id)
                }
            }

            if (activeFilterIds.length === 0) {
                console.log(`   ⚠️  Skipped - no active filters configured`)
                continue
            }

            console.log(`   → Regenerating ${activeFilterIds.length} filters...`)

            // ⭐ Read include_descendants_tree setting (default = true)
            const includeDescendants = category.metadata?.include_descendants_tree ?? true
            console.log(`   → Include descendants: ${includeDescendants}`)

            // Generate new filters using the FIXED logic (with .whereNull("deleted_at"))
            const result = await generateFiltersForCategory(
                category.id,
                activeFilterIds,
                query,
                knex,
                includeDescendants  // ⭐ NEW parameter
            )

            // Update category metadata
            await knex("product_category")
                .where("id", category.id)
                .update({
                    metadata: knex.raw("jsonb_set(metadata, '{filters}', ?)", [
                        JSON.stringify(result.filters)
                    ]),
                    updated_at: new Date()
                })

            console.log(`   ✅ Regenerated ${result.filters.length} filters`)
            successCount++

        } catch (error: any) {
            console.error(`   ❌ Error: ${error.message}`)
            errorCount++
        }
    }

    console.log("\n" + "=".repeat(80))
    console.log(`✅ Mass sync complete:`)
    console.log(`   - Success: ${successCount}`)
    console.log(`   - Errors: ${errorCount}`)
    console.log(`   - Total: ${categoriesWithFilters.length}`)
    console.log("\n💡 Now test in Admin UI or verify with:")
    console.log("   npx medusa exec src/scripts/verify-category-filters.ts\n")
}
