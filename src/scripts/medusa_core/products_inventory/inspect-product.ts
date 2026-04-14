import { ExecArgs } from "@medusajs/framework/types";

/**
 * Inspect a specific product/variant to see its dimensions
 * Run with: npx medusa exec ./src/scripts/inspect-product.ts
 */
export default async function inspectProduct({ container }: ExecArgs) {
  const query = container.resolve("query");

  console.log("\n🔍 Inspecting LPV-100-24...\n");

  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: [
      "id",
      "title",
      "sku",
      "weight",
      "length",
      "height",
      "width",
      "metadata",
    ],
    filters: {
      sku: ["LPV-100-24"],
    },
  });

  if (variants.length === 0) {
    console.log("❌ Variant LPV-100-24 not found in Medusa!");
    return;
  }

  const v = variants[0];
  console.log(`✅ Variant Found: ${v.sku}`);
  console.log(`   - Weight: ${v.weight}`);
  console.log(`   - Length: ${v.length}`);
  console.log(`   - Width: ${v.width}`);
  console.log(`   - Height: ${v.height}`);
  console.log(`   - Metadata:`, v.metadata);
  console.log("\nIf these are null, the sync failed for this item.");
}
