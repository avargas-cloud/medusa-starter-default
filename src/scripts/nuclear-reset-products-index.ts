import { ExecArgs } from "@medusajs/framework/types"

export default async function nuclearResetProductsIndex({ container }: ExecArgs) {
    console.log("☢️ INITIATING NUCLEAR INDEX RESET FOR 'products' ☢️")

    // 1. Dynamic Import
    const { MeiliSearch } = await import("meilisearch")

    const client = new MeiliSearch({
        host: process.env.MEILISEARCH_HOST!,
        apiKey: process.env.MEILISEARCH_API_KEY!,
    })

    const indexName = "products"

    // 2. Total Destruction (deleteIndex)
    try {
        console.log(`... Deleting index '${indexName}' entirely matching Tutor recommendation`)
        await client.deleteIndex(indexName)

        // Wait for task to complete (async indexing engine)
        // Ideally we check task status, but a manual wait here helps ensure propagation
        await new Promise(resolve => setTimeout(resolve, 1000))
        console.log("... Index deleted.")
    } catch (e) {
        console.warn("Index might not exist, continuing...", e.message)
    }

    // 3. Re-Creation & Explicit Configuration
    console.log("... Re-creating index with EXPLICIT displayedAttributes")
    const index = client.index(indexName)

    // Using the schema defined in the Tutor Plan
    const settings = {
        searchableAttributes: ['title', 'description', 'variant_sku', 'handle', 'metadata_material'],
        filterableAttributes: ['id', 'category_handles', 'status', 'variant_sku'],
        sortableAttributes: ['updated_at', 'created_at', 'title', 'status', 'id'],
        // CRITICAL: Explicitly include updated_at and *
        displayedAttributes: ['*', 'updated_at']
    }

    console.log("... Pushing Settings:", JSON.stringify(settings, null, 2))
    const task = await index.updateSettings(settings)

    console.log(`... Settings update enqueued (Task: ${task.taskUid})`)
    await client.tasks.waitForTask(task.taskUid)
    console.log("✅ NUCLEAR RESET COMPLETE. Index is fresh and schema is locked.")
}
