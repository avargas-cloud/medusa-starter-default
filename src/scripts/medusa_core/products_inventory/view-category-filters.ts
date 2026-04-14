#!/usr/bin/env npx tsx
/**
 * View all filters for a category (from metadata.filters)
 * Usage: npx tsx scripts/debug/view-category-filters.ts [category-handle-or-id]
 */

const categoryIdentifier = process.argv[2];

if (!categoryIdentifier) {
  console.error(
    "❌ Usage: npx tsx scripts/debug/view-category-filters.ts [category-handle-or-id]"
  );
  process.exit(1);
}

const basePath = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";

async function main() {
  // Fetch category
  const res = await fetch(
    `${basePath}/store/product-categories/${categoryIdentifier}`,
    {
      headers: {
        "Content-Type": "application/json",
      },
    }
  );

  if (!res.ok) {
    console.error(`❌ Category not found: ${categoryIdentifier}`);
    process.exit(1);
  }

  const { product_category } = await res.json();

  console.log(`\n📂 Category: ${product_category.name}`);
  console.log(`   ID: ${product_category.id}`);
  console.log(`   Handle: ${product_category.handle}`);

  const filters = product_category.metadata?.filters || {};
  const filterCount = Object.keys(filters).length;

  if (filterCount === 0) {
    console.log("\n⚠️  No filters found in metadata.filters");
    console.log(
      "\nRun: curl -X POST http://localhost:9000/admin/product-categories/{id}/sync-attributes"
    );
    process.exit(0);
  }

  console.log(`\n🔎 Filters (${filterCount}):`);
  console.log("─".repeat(80));

  // Sort by handle
  const sorted = Object.entries(filters).sort((a, b) =>
    a[0].localeCompare(b[0])
  );

  for (const [handle, filter] of sorted) {
    const f = filter as any;
    console.log(`\n${f.label} (${handle})`);
    console.log(`  Filter Type: ${f.filter_type || "checkbox"}`);
    console.log(`  Values (${f.values?.length || 0}):`);

    if (f.values && f.values.length > 0) {
      for (const v of f.values) {
        console.log(`    - ${v.value} (${v.count} products)`);
      }
    }
  }

  console.log("\n" + "─".repeat(80));
  console.log(`✅ Total: ${filterCount} filter groups\n`);
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
