/**
 * Clear and Rebuild MeiliSearch Index
 *
 * This script completely clears and rebuilds the products index
 */

import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";

export default async function rebuildMeiliIndex({ container }: ExecArgs) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);

  logger.info("🗑️  Clearing MeiliSearch Index...");

  try {
    const { MeiliSearch } = await import("meilisearch");

    const client = new MeiliSearch({
      host: process.env.MEILISEARCH_HOST!,
      apiKey: process.env.MEILISEARCH_API_KEY!,
    });

    const indexName = "products";

    // Step 1: Delete existing index
    try {
      await client.deleteIndex(indexName);
      logger.info("  ✓ Deleted old index");
      // Wait a bit for deletion
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (e) {
      logger.info("  (No existing index)");
    }

    // Step 2: Fetch all products with categories
    const { data: products } = await query.graph({
      entity: "product",
      fields: [
        "id",
        "title",
        "handle",
        "description",
        "thumbnail",
        "status",
        "material",
        "categories.handle",
        "variants.sku",
      ],
    });

    logger.info(`\n📊 Database Stats:`);
    const published = products.filter(
      (p: any) => p.status === "published"
    ).length;
    const draft = products.filter((p: any) => p.status === "draft").length;
    logger.info(`  Total: ${products.length}`);
    logger.info(`  Published: ${published}`);
    logger.info(`  Draft: ${draft}`);

    // Step 3: Transform products
    const meiliDocs = products.map((p: any) => ({
      id: p.id,
      title: p.title,
      handle: p.handle,
      description: p.description || "",
      thumbnail: p.thumbnail || null,
      status: p.status, // ✅ THIS IS THE KEY FIELD
      metadata_material: p.material || null,
      category_handles: p.categories?.map((c: any) => c.handle) || [], // ✅ Category filtering
      variant_sku: p.variants?.map((v: any) => v.sku).filter(Boolean) || [],
    }));

    logger.info(`\n🔨 Rebuilding index...`);

    // Step 4: Create fresh index and add docs
    const index = client.index(indexName);
    const task = await index.addDocuments(meiliDocs, { primaryKey: "id" });

    logger.info(`  ✓ Added ${meiliDocs.length} documents`);
    logger.info(`  Task ID: ${task.taskUid}`);

    // Step 5: Configure searchable and sortable attributes
    await index.updateSearchableAttributes([
      "title",
      "handle",
      "variant_sku",
      "description",
    ]);

    await index.updateFilterableAttributes([
      "status",
      "metadata_material",
      "category_handles",
    ]); // ✅ Enable category filtering
    await index.updateSortableAttributes(["title", "status", "id"]); // ✅ Enable sorting

    logger.info(`  ✓ Configured search and sort attributes`);

    logger.info("\n✅ DONE!");
    logger.info("Now refresh /app/products-advanced in your browser");
    logger.info("You should see:");
    logger.info(`  - ${published} products with GREEN "published" badge`);
    logger.info(`  - ${draft} products with GREY "draft" badge`);

    return {
      success: true,
      indexed: meiliDocs.length,
      published,
      draft,
    };
  } catch (error: any) {
    logger.error(`❌ ${error.message}`);
    throw error;
  }
}
