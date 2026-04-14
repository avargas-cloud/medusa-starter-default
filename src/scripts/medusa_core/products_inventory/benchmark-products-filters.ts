/**
 * Benchmark Script: Products-With-Filters Endpoint Performance
 *
 * Measures performance of products-with-filters logic using Medusa v2 native APIs
 * Run with: npx medusa exec ./src/scripts/performance/benchmark-products-filters.ts
 */

import { MedusaContainer } from "@medusajs/framework/types";
import { getCacheManager } from "../../lib/cache-manager";

const LED_STRIPS_ID = "pcat_01KGAD1KQXDWJEP7HE92G5FCS4";

export default async function (container: MedusaContainer) {
  console.log("🔥 PERFORMANCE BENCHMARK: Products-With-Filters");
  console.log("=".repeat(70));
  console.log(`Category: LED Strips (${LED_STRIPS_ID})`);
  console.log(`Iterations: 5`);
  console.log("=".repeat(70));
  console.log();

  const results: number[] = [];

  for (let i = 1; i <= 5; i++) {
    console.log(`📊 Iteration ${i}/5...`);

    // Clear cache before each iteration to simulate cold start
    const cacheService = container.resolve("cache");
    const cacheManager = getCacheManager(cacheService);
    const cacheKey = `category:${LED_STRIPS_ID}:products-filters:100:0`;

    try {
      await cacheManager.set(cacheKey, null, 0); // Clear by setting to null with 0 TTL
    } catch (e) {
      // Cache clear might fail, that's okay
    }

    // Small delay to ensure cache is cleared
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Measure performance
    const startTime = performance.now();

    try {
      const result = await fetchProductsWithFilters(
        container,
        LED_STRIPS_ID,
        100,
        0
      );

      const endTime = performance.now();
      const duration = endTime - startTime;

      results.push(duration);

      console.log(`   ⏱️  Time: ${duration.toFixed(2)}ms`);
      console.log(
        `   📦 Products: ${result.products.length}/${result.pagination.total}`
      );
      console.log(`   🔍 Filters: ${result.filters.length}`);
      console.log();
    } catch (error) {
      console.error(`   ❌ Error: ${(error as Error).message}`);
      console.log();
    }
  }

  // Calculate statistics
  if (results.length === 0) {
    console.log("❌ No successful iterations");
    return;
  }

  const avgTime = results.reduce((a, b) => a + b, 0) / results.length;
  const minTime = Math.min(...results);
  const maxTime = Math.max(...results);
  const sortedResults = [...results].sort((a, b) => a - b);
  const medianTime = sortedResults[Math.floor(sortedResults.length / 2)];

  console.log("=".repeat(70));
  console.log("📈 BENCHMARK RESULTS");
  console.log("=".repeat(70));
  console.log(`Average Time: ${avgTime.toFixed(2)}ms`);
  console.log(`Median Time:  ${medianTime.toFixed(2)}ms`);
  console.log(`Min Time:     ${minTime.toFixed(2)}ms`);
  console.log(`Max Time:     ${maxTime.toFixed(2)}ms`);
  console.log("=".repeat(70));

  // Performance assessment
  console.log();
  if (avgTime < 300) {
    console.log("✅ EXCELLENT: Response time < 300ms");
  } else if (avgTime < 1000) {
    console.log("⚠️  ACCEPTABLE: Response time < 1s");
  } else if (avgTime < 3000) {
    console.log("❌ SLOW: Response time > 1s - NEEDS OPTIMIZATION");
  } else {
    console.log(
      "🔥 VERY SLOW: Response time > 3s - CRITICAL OPTIMIZATION NEEDED!"
    );
  }
  console.log();
}

/**
 * Simulates the products-with-filters endpoint logic
 * This is basically the same code as the route handler
 */
async function fetchProductsWithFilters(
  container: MedusaContainer,
  categoryId: string,
  limit: number,
  offset: number
) {
  const query: any = container.resolve("query");
  const knex: any = container.resolve("__pg_connection__");

  // 1. Get category
  const { data: categories } = await query.graph({
    entity: "product_category",
    filters: { id: categoryId },
    fields: ["id", "name", "handle", "parent_category_id", "metadata"],
  });

  if (!categories || categories.length === 0) {
    throw new Error("Category not found");
  }

  const category = categories[0];
  const includeDescendants =
    category.metadata?.include_descendants_tree ?? true;

  // 2. Get descendant category IDs if needed
  let categoryIds = [categoryId];
  if (includeDescendants) {
    const descendants = await getCategoryDescendants(categoryId, query);
    categoryIds = [categoryId, ...descendants];
  }

  // 3. Build product filters
  const productFilters: any = {
    status: "published",
    categories: { id: categoryIds },
  };

  // 4. Query all products for count
  const { data: allProducts } = await query.graph({
    entity: "product",
    filters: productFilters,
    fields: ["id"],
  });

  const totalCount = allProducts.length;

  // 5. Query paginated products
  const { data: paginatedProducts } = await query.graph({
    entity: "product",
    filters: productFilters,
    fields: ["*", "variants.*"],
    pagination: { skip: offset, take: limit },
  });

  // 6. Enrich products (this is where the N+1 problem is)
  const enrichedProducts = await enrichProductsInline(paginatedProducts, knex);

  // 7. Get filters from metadata
  const preCalculatedFilters = (category.metadata?.filters || []) as any[];

  return {
    category: {
      id: category.id,
      name: category.name,
      handle: category.handle,
      include_descendants_tree: includeDescendants,
    },
    products: enrichedProducts,
    filters: preCalculatedFilters,
    pagination: {
      total: totalCount,
      limit,
      offset,
      has_more: offset + enrichedProducts.length < totalCount,
    },
  };
}

/**
 * Inline version of enrichProducts to avoid external dependencies
 */
async function enrichProductsInline(products: any[], knex: any) {
  if (!products || products.length === 0) {
    return products;
  }

  const productIds = products.map((p) => p.id);

  // Batch fetch attribute links
  const attributeLinks = await knex(
    "product_product_productattributes_attribute_value"
  )
    .select("*")
    .whereIn("product_id", productIds);

  if (attributeLinks.length > 0) {
    const attributeValueIds = [
      ...new Set(attributeLinks.map((l: any) => l.attribute_value_id)),
    ];

    const attributeValues = await knex("attribute_value")
      .select(
        "attribute_value.id",
        "attribute_value.value",
        "attribute_key.handle",
        "attribute_key.label"
      )
      .leftJoin(
        "attribute_key",
        "attribute_value.attribute_key_id",
        "attribute_key.id"
      )
      .whereIn("attribute_value.id", attributeValueIds);

    const valueMap = new Map();
    attributeValues.forEach((val: any) => valueMap.set(val.id, val));

    const attributesByProduct = new Map();
    attributeLinks.forEach((link: any) => {
      const attributeValue = valueMap.get(link.attribute_value_id);
      if (attributeValue) {
        if (!attributesByProduct.has(link.product_id)) {
          attributesByProduct.set(link.product_id, []);
        }
        attributesByProduct.get(link.product_id)!.push({
          handle: attributeValue.handle,
          label: attributeValue.label,
          value: attributeValue.value,
        });
      }
    });

    products.forEach((product: any) => {
      product.attributes = attributesByProduct.get(product.id) || [];
    });
  }

  // Price enrichment (THIS IS WHERE THE N+1 PROBLEM IS)
  for (const product of products) {
    if (!product.variants || product.variants.length === 0) continue;

    const variantIds = product.variants.map((v: any) => v.id);

    const prices = await knex("price")
      .select(
        "price.amount",
        "price.currency_code",
        "product_variant_price_set.variant_id"
      )
      .join(
        "product_variant_price_set",
        "price.price_set_id",
        "product_variant_price_set.price_set_id"
      )
      .whereIn("product_variant_price_set.variant_id", variantIds)
      .where("price.currency_code", "usd")
      .whereNull("price.deleted_at");

    if (prices.length === 0) continue;

    const priceMap = new Map<string, number>();
    prices.forEach((p: any) => priceMap.set(p.variant_id, p.amount));

    product.variants.forEach((variant: any) => {
      const amount = priceMap.get(variant.id);
      if (amount !== undefined) {
        Object.assign(variant, {
          calculated_price: {
            calculated_amount: amount,
            currency_code: "usd",
          },
        });
      }
    });

    const amounts = prices.map((p: any) => p.amount);
    const minPrice = Math.min(...amounts);
    const maxPrice = Math.max(...amounts);

    if (minPrice === maxPrice) {
      Object.assign(product, {
        price: { amount: minPrice, currency_code: "usd" },
      });
    } else {
      Object.assign(product, {
        price_range: {
          min: { amount: minPrice, currency_code: "usd" },
          max: { amount: maxPrice, currency_code: "usd" },
        },
      });
    }
  }

  return products;
}

async function getCategoryDescendants(
  categoryId: string,
  query: any
): Promise<string[]> {
  const descendants: string[] = [];
  const visited = new Set<string>();
  const queue = [categoryId];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (visited.has(currentId)) continue;
    visited.add(currentId);

    const { data: children } = await query.graph({
      entity: "product_category",
      filters: { parent_category_id: currentId },
      fields: ["id"],
    });

    for (const child of children) {
      descendants.push(child.id);
      queue.push(child.id);
    }
  }

  return descendants;
}
