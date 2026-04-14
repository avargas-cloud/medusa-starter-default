import { ContainerRegistrationKeys } from "@medusajs/utils";

export default async function checkProductCategories({ container }: any) {
  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
  const productId = "product_01KGAX7RCXVXJVQ8QVHD7W0T54";

  console.log("\n🔍 Checking product categories...\n");

  // Get product info
  const product = await knex("product")
    .select("id", "title", "metadata")
    .where("id", productId)
    .first();

  console.log("📦 Product:", product.title);
  console.log(
    "🏷️  Primary Category ID (metadata):",
    product.metadata?.primary_category_id || "NOT SET"
  );
  console.log("    Full metadata:", JSON.stringify(product.metadata, null, 2));

  // Get all assigned categories
  const categories = await knex("product_category_product as pcp")
    .join("product_category as pc", "pcp.product_category_id", "pc.id")
    .select(
      "pc.id",
      "pc.name",
      "pc.handle",
      "pc.deleted_at",
      "pc.parent_category_id"
    )
    .where("pcp.product_id", productId)
    .whereNull("pcp.deleted_at");

  console.log("\n📁 Assigned Categories:");
  categories.forEach((cat: any, i: number) => {
    console.log(`  ${i + 1}. ${cat.name} (${cat.id})`);
    console.log(`     Handle: ${cat.handle}`);
    console.log(`     Parent: ${cat.parent_category_id || "ROOT"}`);
    console.log(`     Deleted: ${cat.deleted_at ? "YES ❌" : "NO ✅"}`);
  });

  // Check if primary category exists
  if (product.metadata?.primary_category_id) {
    const primaryCat = await knex("product_category")
      .select("id", "name", "deleted_at", "parent_category_id")
      .where("id", product.metadata.primary_category_id)
      .first();

    console.log("\n🎯 Primary Category Status:");
    if (primaryCat) {
      console.log(`   Found: ${primaryCat.name}`);
      console.log(`   ID: ${primaryCat.id}`);
      console.log(`   Parent: ${primaryCat.parent_category_id || "ROOT"}`);
      console.log(`   Deleted: ${primaryCat.deleted_at ? "YES ❌" : "NO ✅"}`);
    } else {
      console.log(`   ❌ NOT FOUND IN DATABASE`);
      console.log(
        `   ⚠️  This is the problem! Category '${product.metadata.primary_category_id}' doesn't exist`
      );
    }
  }

  console.log("\n");
}
