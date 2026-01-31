import { generateFiltersForCategory } from "../modules/category-filters/utils/filter-generator"

export default async function ({ container }: any) {
    const query = container.resolve("query")
    const knex = container.resolve("__pg_connection__")

    const categoryHandle = "led-strips-white"

    console.log(`🔄 QUICK FIX: Regenerate filters for ${categoryHandle}`)

    // Get category
    const { data: categories } = await query.graph({
        entity: "product_category",
        fields: ["id", "name", "metadata"],
        filters: { handle: categoryHandle }
    })

    const category = categories[0]
    const filterConfig = category.metadata.filter_config

    // Extract active filter IDs (old format = string[])
    const activeFilterIds = filterConfig.active_filters || []

    console.log(`📂 Category: ${category.name}`)
    console.log(`🔧 Regenerating ${activeFilterIds.length} filters...`)

    // Generate with FIXED logic (.whereNull("deleted_at"))
    const result = await generateFiltersForCategory(
        category.id,
        activeFilterIds,
        query,
        knex
    )

    // Update metadata
    await knex("product_category")
        .where("id", category.id)
        .update({
            metadata: knex.raw("jsonb_set(metadata, '{filters}', ?)", [
                JSON.stringify(result.filters)
            ]),
            updated_at: new Date()
        })

    console.log(`\n✅ Regenerated filters:`)
    result.filters.forEach((f: any) => {
        console.log(`   - ${f.display_name}: ${f.options?.length || 0} options`)
    })
}
