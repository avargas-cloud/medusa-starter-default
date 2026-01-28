import { ExecArgs } from "@medusajs/framework/types"

export default async function debugSyncComparison({ container }: ExecArgs) {
    const productModule = container.resolve("product")
    const { MeiliSearch } = await import("meilisearch")

    const client = new MeiliSearch({
        host: process.env.MEILISEARCH_HOST!,
        apiKey: process.env.MEILISEARCH_API_KEY!,
    })
    const index = client.index("products")

    console.log("--- DEBUGGING SYNC LOGIC ---")

    // 1. Meili Stats
    let meiliCount = 0
    let meiliLastUpdate = new Date(0)
    try {
        const settings = await index.getSettings()
        console.log("MEILI SETTINGS:", JSON.stringify(settings, null, 2))

        const stats = await index.getStats()
        meiliCount = stats.numberOfDocuments
        console.log(`MEILI: Count = ${meiliCount}`)

        const latestMeili = await index.search("", {
            limit: 1,
            sort: ["updated_at:desc"],
            attributesToRetrieve: ["*"]
        })

        if (latestMeili.hits.length > 0) {
            const hit = latestMeili.hits[0]
            console.log("FULL MEILI DOC:", JSON.stringify(hit, null, 2))
            console.log(`MEILI HEAD: ID=${hit.id}, Title=${hit.title}, updated_at=${hit.updated_at}`)
            if (hit.updated_at) meiliLastUpdate = new Date(hit.updated_at)
        } else {
            console.log("MEILI: No hits found (Index empty?)")
        }
    } catch (e) {
        console.error("MEILI ERROR:", e.message)
    }

    // 2. DB Stats
    const [_, dbCount] = await productModule.listAndCountProducts({}, { select: ["id"], take: 0 })
    console.log(`DB: Count = ${dbCount}`)

    const [latestProduct] = await productModule.listProducts({}, {
        select: ["updated_at", "title", "id"],
        order: { updated_at: "DESC" },
        take: 1
    })

    let dbLastUpdate = new Date(0)
    if (latestProduct) {
        dbLastUpdate = new Date(latestProduct.updated_at)
        console.log(`DB HEAD: ID=${latestProduct.id}, Title=${latestProduct.title}, updated_at=${dbLastUpdate.toISOString()} (Ts: ${dbLastUpdate.getTime()})`)
    } else {
        console.log("DB: No products found")
    }

    // 3. Comparison
    console.log("--- COMPARISON ---")
    console.log(`Count Sync: ${dbCount} === ${meiliCount} ? ${dbCount === meiliCount}`)

    const diff = Math.abs(dbLastUpdate.getTime() - meiliLastUpdate.getTime())
    console.log(`Time Diff: ${diff}ms`)
    console.log(`Time Sync (< 2000ms): ${diff < 2000}`)
}
