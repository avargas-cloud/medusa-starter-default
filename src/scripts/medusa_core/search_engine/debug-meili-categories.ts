/**
 * Debug: Check category distribution in MeiliSearch inventory index
 */
import "dotenv/config"

async function checkCategoryDistribution() {
    const { MeiliSearch } = await import("meilisearch")

    console.log("\n🔍 Checking MeiliSearch Inventory Categories...\n")

    const client = new MeiliSearch({
        host: process.env.MEILISEARCH_HOST!,
        apiKey: process.env.MEILISEARCH_API_KEY!,
    })

    const index = client.index("inventory")

    try {
        // Get all items (up to 1000)
        const results = await index.search("", { limit: 1000 })

        console.log(`Total items in index: ${results.hits.length}`)
        console.log(`Estimated total: ${results.estimatedTotalHits}\n`)

        // Count items with/without category
        const withCategory = results.hits.filter((h: any) => h.categoryId)
        const withoutCategory = results.hits.filter((h: any) => !h.categoryId)

        console.log(`✅ Items WITH category: ${withCategory.length}`)
        console.log(`❌ Items WITHOUT category: ${withoutCategory.length}\n`)

        // Category distribution
        const categoryStats: Record<string, number> = {}
        withCategory.forEach((item: any) => {
            const handle = item.categoryHandle || "unknown"
            categoryStats[handle] = (categoryStats[handle] || 0) + 1
        })

        console.log("📊 Category Distribution:")
        Object.entries(categoryStats)
            .sort((a, b) => b[1] - a[1])
            .forEach(([handle, count]) => {
                console.log(`   ${handle}: ${count} items`)
            })

        // Sample items without category
        if (withoutCategory.length > 0) {
            console.log("\n🔍 Sample items WITHOUT category:")
            withoutCategory.slice(0, 3).forEach((item: any) => {
                console.log(`   SKU: ${item.sku} | Title: ${item.title}`)
            })
        }

        // Sample items with category
        if (withCategory.length > 0) {
            console.log("\n✅ Sample items WITH category:")
            withCategory.slice(0, 3).forEach((item: any) => {
                console.log(`   SKU: ${item.sku} | Category: ${item.categoryHandle} (${item.categoryId})`)
            })
        }

        console.log("\n")
    } catch (error: any) {
        console.error("❌ Error:", error.message)
        process.exit(1)
    }
}

checkCategoryDistribution()
