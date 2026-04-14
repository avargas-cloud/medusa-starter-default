import { MedusaAppLoader, Modules } from "@medusajs/framework";

const productId = process.argv[2];

if (!productId) {
  console.error(
    "❌ Usage: node dist/scripts/check-product-attrs.js [product-id]"
  );
  process.exit(1);
}

async function main() {
  const { medusaApp } = await MedusaAppLoader.load({
    directory: process.cwd(),
  });
  const query = medusaApp.modules.query as any;

  // Get product with attributes
  const { data: products } = await query.graph({
    entity: "product",
    fields: [
      "id",
      "title",
      "handle",
      "attribute_values.id",
      "attribute_values.value",
      "attribute_values.attribute_key.label",
      "attribute_values.attribute_key.handle",
    ],
    filters: { id: productId },
  });

  if (!products || products.length === 0) {
    console.error(`❌ Product not found: ${productId}`);
    process.exit(1);
  }

  const product = products[0];

  console.log(`\n📦 ${product.title}`);
  console.log(`   ID: ${product.id}`);
  console.log(`   Handle: ${product.handle}\n`);

  if (!product.attribute_values || product.attribute_values.length === 0) {
    console.log("⚠️  No attributes found\n");
    process.exit(0);
  }

  console.log("🏷️  ATTRIBUTES:");
  console.log("─".repeat(80));

  for (const av of product.attribute_values) {
    console.log(`${av.attribute_key.label}: ${av.value}`);
  }

  console.log("─".repeat(80));
  console.log(`\n✅ Total: ${product.attribute_values.length} attributes\n`);

  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
