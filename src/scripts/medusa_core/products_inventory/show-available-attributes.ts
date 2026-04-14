import { Modules } from "@medusajs/utils";
import { MedusaAppLoader } from "@medusajs/framework";

async function main() {
  console.log("🔍 Loading Medusa app...");

  const { medusaApp } = await MedusaAppLoader.load({
    directory: process.cwd(),
  });

  const query = medusaApp.modules[Modules.QUERY] as any;

  console.log("📊 Fetching WHITE LED STRIPS category...\n");

  const { data: categories } = await query.graph({
    entity: "product_category",
    fields: ["id", "name", "metadata"],
    filters: { name: "WHITE LED STRIPS" },
  });

  if (!categories || categories.length === 0) {
    console.error("❌ Category not found");
    process.exit(1);
  }

  const category = categories[0];

  console.log(`Category: ${category.name} (${category.id})\n`);
  console.log("=".repeat(80));
  console.log("FULL METADATA JSON:");
  console.log("=".repeat(80));
  console.log(JSON.stringify(category.metadata, null, 2));

  console.log("\n" + "=".repeat(80));
  console.log("AVAILABLE_ATTRIBUTES ONLY:");
  console.log("=".repeat(80));
  console.log(JSON.stringify(category.metadata?.available_attributes, null, 2));

  console.log("\n" + "=".repeat(80));
  console.log("STATS:");
  console.log("=".repeat(80));
  console.log(
    `available_attributes: ${category.metadata?.available_attributes?.length || 0} items`
  );
  console.log(`filters: ${category.metadata?.filters?.length || 0} items`);
  console.log(
    `filters_metadata.total_products: ${category.metadata?.filters_metadata?.total_products || "N/A"}`
  );

  await medusaApp.onApplicationShutdown();
  process.exit(0);
}

main().catch((error) => {
  console.error("❌ Error:", error.message);
  process.exit(1);
});
