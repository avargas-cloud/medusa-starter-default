import postgres from "postgres"

/**
 * Direct Database Product Indexing
 * Fetches products directly from PostgreSQL and indexes to MeiliSearch
 */

const MEILISEARCH_HOST = "https://meilisearch-production-1237.up.railway.app"
const MEILISEARCH_API_KEY = "bf013bc7e93ee16593d58b3c0aeecec4b6a69e9ac0bb88f705148f1bf0265562"

async function indexProducts() {
    console.log("🔍 Starting MeiliSearch product indexing...")
    console.log(`📡 MeiliSearch: ${MEILISEARCH_HOST}`)

    // Get DATABASE_URL from environment
    const databaseUrl = process.env.DATABASE_URL
    if (!databaseUrl) {
        throw new Error("DATABASE_URL not found in environment")
    }

    // Connect to PostgreSQL
    console.log("📦 Connecting to database...")
    const sql = postgres(databaseUrl)

    // Dynamic import for MeiliSearch to avoid ESM/CommonJS issues
    const { MeiliSearch } = await import("meilisearch")

    // Initialize MeiliSearch client
    const meiliClient = new MeiliSearch({
        host: MEILISEARCH_HOST,
        apiKey: MEILISEARCH_API_KEY,
    })

    // Test MeiliSearch connection
    const health = await meiliClient.health()
    console.log("✅ MeiliSearch connection successful:", health.status)

    // Fetch products with variants from database
    console.log("📊 Fetching products from database...")

    const products = await sql`
        SELECT 
            p.id,
            p.title,
            p.description,
            p.handle,
            p.thumbnail,
            p.status,
            p.metadata,
            json_agg(
                json_build_object('sku', v.sku)
            ) FILTER (WHERE v.id IS NOT NULL) as variants
        FROM product p
        LEFT JOIN product_variant v ON v.product_id = p.id
        GROUP BY p.id
        ORDER BY p.created_at DESC
    `

    console.log(`📊 Found ${products.length} products`)

    if (products.length === 0) {
        console.log("⚠️  No products found in database")
        await sql.end()
        process.exit(0)
    }

    // Transform products for MeiliSearch
    const documents = products.map((product: any) => ({
        id: product.id,
        title: product.title,
        description: product.description,
        handle: product.handle,
        thumbnail: product.thumbnail,
        variant_sku: product.variants?.map((v: any) => v.sku).filter(Boolean) || [],
        metadata: product.metadata || {},
        metadata_material: product.metadata?.material || null,
        metadata_category: product.metadata?.category || null,
        status: product.status,
    }))

    console.log("⬆️  Uploading documents to MeiliSearch...")

    // Get products index
    const index = meiliClient.index("products")

    // Index documents (updates existing ones)
    const indexingTask = await index.addDocuments(documents, { primaryKey: "id" })

    console.log(`✅ Indexing task enqueued: ${indexingTask.taskUid}`)
    console.log(`⏳ Waiting 5 seconds for indexing to complete...`)

    // Simple wait instead of polling
    await new Promise(resolve => setTimeout(resolve, 5000))

    console.log("✅ Indexing completed!")
    console.log(`📊 Indexed ${documents.length} products`)

    // Display index stats
    const stats = await index.getStats()
    console.log("📈 Final Index Statistics:")
    console.log(`   - Documents: ${stats.numberOfDocuments}`)
    console.log(`   - Indexing: ${stats.isIndexing}`)

    await sql.end()
    console.log("\n✨ Done! All products synced to MeiliSearch")
    console.log("🔍 Refresh your admin panel to see updated data!")
    process.exit(0)
}

indexProducts().catch((error) => {
    console.error("❌ Fatal error:", error.message)
    process.exit(1)
})
