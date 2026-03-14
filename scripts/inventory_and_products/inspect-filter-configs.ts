export default async function ({ container }: any) {
    const query = container.resolve("query")

    const { data: categories } = await query.graph({
        entity: "product_category",
        fields: ["id", "name", "metadata"],
        filters: {}
    })

    const withFilters = categories.filter((c: any) => c.metadata?.filter_config)

    console.log(`📂 Categories with filter_config: ${withFilters.length}`)

    withFilters.slice(0, 3).forEach((cat: any) => {
        console.log(`\n${cat.name}:`)
        console.log(JSON.stringify(cat.metadata.filter_config, null, 2))
    })
}
