import postgres from "postgres";

/**
 * Direct Database Category Indexing
 * Fetches product_categories from PostgreSQL and indexes to MeiliSearch
 * Photos are stored in category metadata (metadata.image or metadata.thumbnail)
 */

const MEILISEARCH_HOST = "https://meilisearch-production-1237.up.railway.app";
const MEILISEARCH_API_KEY =
  process.env.MEILISEARCH_API_KEY;

async function indexCategories() {
  console.log("🔍 Starting MeiliSearch category indexing...");
  console.log(`📡 MeiliSearch: ${MEILISEARCH_HOST}`);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL not found in environment");

  console.log("📦 Connecting to database...");
  const sql = postgres(databaseUrl);

  const { MeiliSearch } = await import("meilisearch");
  const meiliClient = new MeiliSearch({
    host: MEILISEARCH_HOST,
    apiKey: MEILISEARCH_API_KEY,
  });

  const health = await meiliClient.health();
  console.log("✅ MeiliSearch connection:", health.status);

  console.log("📊 Fetching categories from database...");
  const categories = await sql`
        SELECT
            pc.id,
            pc.name,
            pc.handle,
            pc.description,
            pc.metadata,
            pc.parent_category_id,
            parent.name AS parent_name,
            parent.handle AS parent_handle
        FROM product_category pc
        LEFT JOIN product_category parent ON parent.id = pc.parent_category_id
        WHERE pc.is_active = true
        ORDER BY pc.rank ASC, pc.created_at DESC
    `;

  console.log(`📊 Found ${categories.length} categories`);

  if (categories.length === 0) {
    console.log("⚠️  No active categories found");
    await sql.end();
    process.exit(0);
  }

  // Transform — image/thumbnail comes from metadata
  const documents = categories.map((cat: any) => ({
    id: cat.id,
    name: cat.name,
    handle: cat.handle,
    description: cat.description || null,
    // thumbnail = direct URL string; image = { url: "..." } object
    thumbnail:
      cat.metadata?.thumbnail ??
      (cat.metadata?.image as { url?: string } | null)?.url ??
      null,
    metadata: cat.metadata || {},
    parent_category_id: cat.parent_category_id || null,
    parent_name: cat.parent_name || null,
    parent_handle: cat.parent_handle || null,
  }));

  // Log a sample to verify metadata structure
  if (documents[0]) {
    console.log("📋 Sample category:", JSON.stringify(documents[0], null, 2));
  }

  console.log("⬆️  Uploading to MeiliSearch index: product_categories...");
  const index = meiliClient.index("product_categories");

  // Configure searchable + filterable attributes
  await index.updateSettings({
    searchableAttributes: ["name", "description", "parent_name"],
    displayedAttributes: [
      "id",
      "name",
      "handle",
      "thumbnail",
      "parent_name",
      "parent_handle",
    ],
    filterableAttributes: ["parent_category_id"],
    sortableAttributes: [],
  });

  const task = await index.addDocuments(documents, { primaryKey: "id" });
  console.log(`✅ Indexing task enqueued: ${task.taskUid}`);

  await new Promise((resolve) => setTimeout(resolve, 5000));

  const stats = await index.getStats();
  console.log("📈 Index stats:");
  console.log(`   - Documents: ${stats.numberOfDocuments}`);
  console.log(`   - Indexing: ${stats.isIndexing}`);

  await sql.end();
  console.log("\n✨ Done! All categories synced to MeiliSearch");
  process.exit(0);
}

indexCategories().catch((error) => {
  console.error("❌ Fatal error:", error.message);
  process.exit(1);
});
