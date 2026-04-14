/**
 * Re-sync all category attributes with the new recursive logic
 *
 * This script triggers the sync-attributes endpoint for ALL categories,
 * which will now include products from descendant categories.
 *
 * Run after deploying the recursive aggregation changes.
 *
 * Usage: npx tsx src/scripts/resync-all-category-attributes.ts
 */

async function main() {
  console.log(
    "🔄 Starting full category attributes re-sync with recursive aggregation...\n"
  );

  const basePath = "http://localhost:9000";

  // Fetch all categories using the admin endpoint
  const categoriesResponse = await fetch(
    `${basePath}/admin/product-categories?limit=9999`,
    {
      credentials: "include",
    }
  );

  if (!categoriesResponse.ok) {
    throw new Error(`Failed to fetch categories: ${categoriesResponse.status}`);
  }

  const { product_categories: allCategories } = await categoriesResponse.json();

  console.log(`📦 Found ${allCategories.length} categories to sync\n`);

  let successCount = 0;
  let errorCount = 0;

  for (const category of allCategories) {
    try {
      const response = await fetch(
        `${basePath}/admin/product-categories/${category.id}/sync-attributes`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
        }
      );

      if (response.ok) {
        const result = await response.json();
        console.log(
          `  ✅ ${category.name}: ${result.attributeCount} attributes from ${result.productCount} products`
        );
        successCount++;
      } else {
        console.error(`  ❌ ${category.name}: HTTP ${response.status}`);
        errorCount++;
      }
    } catch (error: any) {
      console.error(`  ❌ ${category.name}: ${error.message}`);
      errorCount++;
    }

    // Rate limit: 100ms delay between categories to avoid overwhelming the server
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(
    `✅ Re-sync complete: ${successCount} success, ${errorCount} errors`
  );
  console.log(`${"=".repeat(60)}\n`);

  process.exit(0);
}

main().catch((error) => {
  console.error("❌ Fatal error:", error);
  process.exit(1);
});
