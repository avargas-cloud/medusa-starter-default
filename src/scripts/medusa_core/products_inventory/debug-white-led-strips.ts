/**
 * Debug script to check "White LED strips" category products
 *
 * Verifies which products are in the category and their status
 */

async function main() {
  const basePath = "http://localhost:9000";

  console.log("🔍 Checking 'White LED strips' category...\n");

  // 1. Find the category
  const categoriesResponse = await fetch(
    `${basePath}/admin/product-categories?q=White LED&limit=10`,
    { credentials: "include" }
  );
  const { product_categories } = await categoriesResponse.json();

  const whiteStripsCategory = product_categories.find(
    (c: any) => c.name === "WHITE LED STRIPS"
  );

  if (!whiteStripsCategory) {
    console.error("❌ Category 'WHITE LED STRIPS' not found");
    process.exit(1);
  }

  console.log(
    `✅ Found category: ${whiteStripsCategory.name} (${whiteStripsCategory.id})`
  );

  // 2. Get ALL products (published + draft)
  const allProductsResponse = await fetch(
    `${basePath}/admin/products?category_id[]=${whiteStripsCategory.id}&limit=100`,
    { credentials: "include" }
  );
  const { products: allProducts } = await allProductsResponse.json();

  console.log(`\n📦 Total products in category: ${allProducts.length}\n`);

  // 3. Group by status
  const published = allProducts.filter((p: any) => p.status === "published");
  const draft = allProducts.filter((p: any) => p.status === "draft");

  console.log(`✅ Published: ${published.length}`);
  published.forEach((p: any) => {
    console.log(`   - ${p.title} (${p.id})`);
  });

  console.log(`\n📝 Draft: ${draft.length}`);
  draft.forEach((p: any) => {
    console.log(`   - ${p.title} (${p.id})`);
  });

  // 4. Check category metadata
  console.log(`\n📊 Category metadata:`);
  console.log(
    `   available_attributes: ${whiteStripsCategory.metadata?.available_attributes?.length || 0}`
  );

  process.exit(0);
}

main().catch((error) => {
  console.error("❌ Error:", error.message);
  process.exit(1);
});
