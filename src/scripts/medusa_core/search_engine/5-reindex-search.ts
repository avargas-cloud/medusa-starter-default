/**
 * Phase 5: Re-index MeiliSearch
 *
 * Purpose:
 * - Re-index all products in MeiliSearch with new ULID IDs
 * - Update search index to reflect migrated product IDs
 *
 * Note: MeiliSearch plugin (@rokmohar/medusa-plugin-meilisearch) will
 * automatically sync when the server starts, but this script can force
 * a manual re-index if needed.
 *
 * Usage:
 *   npx tsx scripts/product-id-migration/5-reindex-search.ts
 */

import dotenv from "dotenv";
dotenv.config();

import { MeiliSearch } from "meilisearch";

const MEILISEARCH_HOST =
  process.env.MEILISEARCH_HOST || "http://localhost:7700";
const MEILISEARCH_API_KEY = process.env.MEILISEARCH_API_KEY || "masterKey";

async function main() {
  console.log("🚀 Product ID Migration - Phase 5: Re-index MeiliSearch\n");

  try {
    // 1. Connect to MeiliSearch
    console.log(`🔗 Connecting to MeiliSearch at ${MEILISEARCH_HOST}...`);
    const client = new MeiliSearch({
      host: MEILISEARCH_HOST,
      apiKey: MEILISEARCH_API_KEY,
    });

    // Check if MeiliSearch is available
    const health = await client.health();
    console.log(`✅ MeiliSearch is ${health.status}\n`);

    // 2. Get product index
    console.log("📊 Fetching product index...");
    const index = client.index("products");

    try {
      const stats = await index.getStats();
      console.log(`   Current documents: ${stats.numberOfDocuments}`);
    } catch (error) {
      console.log("   Index not found or empty");
    }

    // 3. Clear old index (products will have old IDs)
    console.log("\n🗑️  Clearing old index...");
    await index.deleteAllDocuments();
    console.log("✅ Old index cleared\n");

    console.log("ℹ️  Index cleared successfully");
    console.log("\nNext steps:");
    console.log("  1. Restart Medusa server: yarn dev");
    console.log(
      "  2. The MeiliSearch plugin will auto-index all products with new IDs"
    );
    console.log("  3. Verify search works in Admin UI\n");
  } catch (error: any) {
    if (error.message?.includes("ECONNREFUSED")) {
      console.log("\n⚠️  MeiliSearch is not running!");
      console.log("\nTo re-index MeiliSearch:");
      console.log("  1. Start MeiliSearch (if not running)");
      console.log("  2. Restart Medusa server: yarn dev");
      console.log("  3. The plugin will automatically re-index all products\n");
      console.log("OR manually clear the index:");
      console.log(
        "  curl -X DELETE 'http://localhost:7700/indexes/products/documents' \\"
      );
      console.log("       -H 'Authorization: Bearer masterKey'\n");
    } else {
      console.error("❌ Re-index failed:", error);
      throw error;
    }
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
