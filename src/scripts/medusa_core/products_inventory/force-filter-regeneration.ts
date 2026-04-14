import { ExecArgs } from "@medusajs/framework/types";

export default async function ({ container }: ExecArgs) {
  const query = container.resolve("query");

  console.log("\n🔄 FORCING FILTER REGENERATION");
  console.log("=".repeat(80));

  const productId = "prod_ul-freecut-cob-led-strip-single-color-bright-output";

  // Get product categories using remoteQuery
  const products = await query.graph({
    entity: "product",
    fields: ["id", "title", "categories.id", "categories.name"],
    filters: { id: productId },
  });

  const product = products.data[0];

  console.log(`\n📦 Product: ${product.title}`);
  console.log(`📂 Categories: ${product.categories?.length || 0}`);

  if (!product.categories || product.categories.length === 0) {
    console.log("⚠️  No categories found");
    return;
  }

  // Trigger sync for each category
  const baseUrl = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";

  for (const category of product.categories) {
    console.log(`\n🔄 Syncing category: ${category.name} (${category.id})`);

    try {
      const response = await fetch(
        `${baseUrl}/admin/product-categories/${category.id}/sync-attributes`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
        }
      );

      if (response.ok) {
        const data = await response.json();
        console.log(`   ✅ Synced - ${data.filters_count || 0} filters`);
      } else {
        console.error(`   ❌ Error: ${response.status} ${response.statusText}`);
      }
    } catch (error: any) {
      console.error(`   ❌ Error: ${error.message}`);
    }
  }

  console.log("\n" + "=".repeat(80));
  console.log("✅ Filter regeneration complete");
  console.log(
    "\nNow check filters with: npx medusa exec src/scripts/verify-category-filters.ts\n"
  );
}
