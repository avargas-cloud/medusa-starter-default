import { ExecArgs } from "@medusajs/framework/types"
import { generateFiltersForCategory } from "../modules/category-filters/utils/filter-generator"

export default async function ({ container }: ExecArgs) {
    const query = container.resolve("query")
    const knex = container.resolve("__pg_connection__")

    console.log("\n🔄 SMART MASS FILTER SYNC")
    console.log("=".repeat(80))

    // Get all categories with filter_config
    const { data: allCategories } = await query.graph({
        entity: "product_category",
        fields: ["id", "handle", "name", "metadata", "parent_category_id"],
        filters: {}
    })

    const categoriesWithFilters = allCategories.filter((cat: any) =>
        cat.metadata?.filter_config?.active_filters?.length > 0
    )

    console.log(`\n📂 Found ${categoriesWithFilters.length} categories with configured filters`)

    // Count descendants for each
    const descendantCounts = new Map()
    for (const cat of categoriesWithFilters) {
        const descendants = allCategories.filter((c: any) => {
            let current = c
            while (current.parent_category_id) {
                if (current.parent_category_id === cat.id) return true
                current = allCategories.find((p: any) => p.id === current.parent_category_id)
                if (!current) break
            }
            return false
        })
        descendantCounts.set(cat.id, descendants.length)
    }

    // Skip categories with >50 descendants (too slow)
    const toProcess = categoriesWithFilters.filter((cat: any) => {
        const count = descendantCounts.get(cat.id) || 0
        if (count > 50) {
            console.log(`   ⏭️  Skipping "${cat.name}" - ${count} descendants (too slow)`)
            return false
        }
        return true
    })

    console.log(`\n✅ Will process ${toProcess.length} categories (skipped ${categoriesWithFilters.length - toProcess.length} large ones)`)

    if (toProcess.length === 0) {
        console.log("\n⚠️  No categories to process")
        return
    }

    let successCount = 0
    let errorCount = 0

    // Process
    for (const category of toProcess) {
        console.log(`\n🔄 [${successCount + errorCount + 1}/${toProcess.length}] ${category.name}`)

        try {
            const filterConfig = category.metadata.filter_config

            // Handle both formats
            let activeFilterIds: string[] = []

            if (Array.isArray(filterConfig.active_filters) && filterConfig.active_filters.length > 0) {
                const first = filterConfig.active_filters[0]
                if (typeof first === "string") {
                    activeFilterIds = filterConfig.active_filters
                } else if (typeof first === "object" && first?.attribute_id) {
                    activeFilterIds = filterConfig.active_filters.map((f: any) => f.attribute_id)
                }
            }

            if (activeFilterIds.length === 0) {
                console.log(`   ⚠️  Skipped - no active filters`)
                continue
            }

            console.log(`   → Regenerating ${activeFilterIds.length} filters...`)

            const result = await generateFiltersForCategory(
                category.id,
                activeFilterIds,
                query,
                knex
            )

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
    console.log(`✅ Smart sync complete:`)
    console.log(`   - Success: ${successCount}`)
    console.log(`   - Errors: ${errorCount}`)
    console.log(`   - Skipped (too large): ${categoriesWithFilters.length - toProcess.length}`)
    console.log(`\n💡 For large categories, use quick-fix script with specific handle`)
}
