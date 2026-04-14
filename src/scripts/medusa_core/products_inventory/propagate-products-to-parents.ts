import { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

/**
 * Propagate Products to Parent Categories
 *
 * For every product in a child category, also assigns it to all parent categories
 * in the hierarchy.
 *
 * Example:
 *   Product in "White LED Strips" → Also assigned to "LED Strips" (parent)
 *
 * Run with: npx medusa exec ./src/scripts/propagate-products-to-parents.ts
 */

export default async function propagateProductsToParents({
  container,
}: ExecArgs) {
  console.log("🚀 Starting product propagation to parent categories...\n");

  const query = container.resolve("query");
  const productService = container.resolve(Modules.PRODUCT);

  try {
    // Step 1: Get all categories with parent relationships
    console.log("📂 Step 1: Loading all categories...");

    const { data: allCategories } = await query.graph({
      entity: "product_category",
      fields: ["id", "name", "handle", "parent_category_id"],
      pagination: { take: 5000 },
    });

    console.log(`✅ Loaded ${allCategories.length} categories`);

    // Build parent chain function
    const getAncestors = (categoryId: string): string[] => {
      const ancestors: string[] = [];
      let currentId: string | null = categoryId;

      while (currentId) {
        const cat = allCategories.find((c) => c.id === currentId);
        if (!cat || !cat.parent_category_id) break;

        ancestors.push(cat.parent_category_id);
        currentId = cat.parent_category_id;
      }

      return ancestors;
    };

    // Step 2: Get all products
    console.log("\n📦 Step 2: Loading all products...");

    const { data: products } = await query.graph({
      entity: "product",
      fields: ["id", "title"],
      pagination: { take: 10000 },
    });

    console.log(`✅ Loaded ${products.length} products`);

    // Step 2b: Get product-category links
    console.log("\n🔗 Step 2b: Loading product-category links...");

    const { data: productCategoryLinks } = await query.graph({
      entity: "product_category_product",
      fields: ["product_id", "product_category_id"],
      pagination: { take: 50000 },
    });

    console.log(
      `✅ Loaded ${productCategoryLinks.length} product-category links`
    );

    // Build product -> categories map
    const productCategoriesMap = new Map<string, string[]>();
    for (const link of productCategoryLinks) {
      const existing = productCategoriesMap.get(link.product_id) || [];
      existing.push(link.product_category_id);
      productCategoriesMap.set(link.product_id, existing);
    }

    // Step 3: For each product, calculate all categories it should be in
    console.log("\n🔄 Step 3: Calculating parent category assignments...");

    let productsUpdated = 0;
    let categoriesAdded = 0;

    for (const product of products) {
      const currentCategoryIds = productCategoriesMap.get(product.id) || [];
      if (currentCategoryIds.length === 0) continue;

      // Get current category IDs as Set
      const currentCategoryIdSet = new Set(currentCategoryIds);

      // Find all ancestors for current categories
      const allRequiredCategoryIds = new Set(currentCategoryIdSet);

      for (const categoryId of currentCategoryIdSet) {
        const ancestors = getAncestors(categoryId);
        ancestors.forEach((ancestorId) =>
          allRequiredCategoryIds.add(ancestorId)
        );
      }

      // Check if we need to add any new categories
      const newCategoriesToAdd = Array.from(allRequiredCategoryIds).filter(
        (id) => !currentCategoryIdSet.has(id)
      );

      if (newCategoriesToAdd.length === 0) continue;

      // Update product with all categories (current + parents)
      await productService.updateProducts(product.id, {
        category_ids: Array.from(allRequiredCategoryIds),
      });

      productsUpdated++;
      categoriesAdded += newCategoriesToAdd.length;

      if (productsUpdated % 20 === 0) {
        console.log(`   Processed ${productsUpdated} products...`);
      }

      // Log what was added
      const addedNames = newCategoriesToAdd
        .map((id) => allCategories.find((c) => c.id === id)?.name || id)
        .join(", ");

      console.log(
        `   ✅ ${product.title}: +${newCategoriesToAdd.length} parent(s) (${addedNames})`
      );
    }

    // Summary
    console.log("\n" + "=".repeat(50));
    console.log("📊 SUMMARY");
    console.log("=".repeat(50));
    console.log(`✅ Products updated: ${productsUpdated}`);
    console.log(`✅ Parent category assignments added: ${categoriesAdded}`);
    console.log("\nAll products now appear in their parent categories");
    console.log("=".repeat(50));
  } catch (error) {
    console.error("❌ Error:", error);
    throw error;
  }
}
