#!/usr/bin/env npx tsx
/**
 * List all categories with their IDs
 * Usage: npx tsx scripts/debug/list-categories.ts [search-term]
 */

const searchTerm = process.argv[2] || "";
const basePath = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";

async function main() {
  const url = searchTerm
    ? `${basePath}/admin/product-categories?q=${encodeURIComponent(searchTerm)}&limit=100`
    : `${basePath}/admin/product-categories?limit=100`;

  const res = await fetch(url);

  if (!res.ok) {
    console.error(`❌ Failed to fetch categories: ${res.status}`);
    process.exit(1);
  }

  const { product_categories, count } = await res.json();

  console.log(
    `\n📂 Categories${searchTerm ? ` matching "${searchTerm}"` : ""} (showing ${product_categories.length} of ${count}):`
  );
  console.log("─".repeat(80));

  for (const cat of product_categories) {
    const indent = "  ".repeat(cat.rank || 0);
    console.log(`\n${indent}${cat.name}`);
    console.log(`${indent}  ID: ${cat.id}`);
    console.log(`${indent}  Handle: ${cat.handle}`);

    const filterCount = cat.metadata?.filters
      ? Object.keys(cat.metadata.filters).length
      : 0;
    if (filterCount > 0) {
      console.log(`${indent}  Filters: ${filterCount} configured`);
    }
  }

  console.log("\n" + "─".repeat(80));
  console.log(`\n✅ Total: ${count} categories\n`);
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
