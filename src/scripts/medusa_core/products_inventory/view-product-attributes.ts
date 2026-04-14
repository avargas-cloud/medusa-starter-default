#!/usr/bin/env npx tsx
/**
 * View all attributes for a product
 * Usage: npx tsx scripts/debug/view-product-attributes.ts [product-handle-or-id]
 */

const productIdentifier = process.argv[2];

if (!productIdentifier) {
  console.error(
    "❌ Usage: npx tsx scripts/debug/view-product-attributes.ts [product-handle-or-id]"
  );
  process.exit(1);
}

const basePath = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";

async function main() {
  // Fetch product
  const res = await fetch(`${basePath}/admin/products/${productIdentifier}`, {
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    console.error(`❌ Product not found: ${productIdentifier}`);
    process.exit(1);
  }

  const { product } = await res.json();

  console.log(`\n📦 Product: ${product.title}`);
  console.log(`   ID: ${product.id}`);
  console.log(`   Handle: ${product.handle}`);
  console.log(`   Status: ${product.status}`);

  if (!product.attribute_values || product.attribute_values.length === 0) {
    console.log("\n⚠️  No attributes found");
    process.exit(0);
  }

  console.log(`\n🏷️  Attributes (${product.attribute_values.length}):`);
  console.log("─".repeat(80));

  // Group by attribute key
  const grouped = new Map<string, any[]>();
  for (const av of product.attribute_values) {
    const key = av.attribute_key;
    if (!grouped.has(key.handle)) {
      grouped.set(key.handle, []);
    }
    grouped.get(key.handle)!.push(av);
  }

  // Sort by handle
  const sorted = Array.from(grouped.entries()).sort((a, b) =>
    a[0].localeCompare(b[0])
  );

  for (const [handle, values] of sorted) {
    const key = values[0].attribute_key;
    console.log(`\n${key.label} (${handle})`);
    console.log(`  ID: ${key.id}`);
    console.log(`  Filter Type: ${key.filter_type || "checkbox"}`);

    if (values.length === 1) {
      console.log(`  Value: ${values[0].value}`);
    } else {
      console.log(`  Values:`);
      for (const v of values) {
        console.log(`    - ${v.value}`);
      }
    }
  }

  console.log("\n" + "─".repeat(80));
  console.log(
    `✅ Total: ${product.attribute_values.length} attribute values across ${grouped.size} attribute keys\n`
  );
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
