import { ExecArgs } from "@medusajs/framework/types";

export default async function syncCategoryFilters({ container }: ExecArgs) {
  const categoryId = "pcat_led-strips-white";

  console.log(`\n🔄 SYNCING FILTERS FOR CATEGORY: ${categoryId}`);
  console.log("─".repeat(80));

  const basePath = "http://localhost:9000";

  try {
    const response = await fetch(
      `${basePath}/admin/product-categories/${categoryId}/sync-attributes`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error(`❌ Sync failed: ${response.status}`);
      console.error(error);
      return;
    }

    const result = await response.json();
    console.log(`\n✅ Sync completed successfully!`);
    console.log(`   Filters generated: ${result.filterCount}`);
    console.log(`   Products processed: ${result.productCount}`);
    console.log(`   Category: ${result.category}`);
  } catch (error: any) {
    console.error(`❌ Error:`, error.message);
  }
}
