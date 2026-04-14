import { ExecArgs } from "@medusajs/framework/types";

/**
 * Force update the dimensions of LPV-100-24 using Query Graph (safer API)
 * Run with: npx medusa exec ./src/scripts/test-update-variant-graph.ts
 */
export default async function testUpdateVariantGraph({ container }: ExecArgs) {
  console.log("\n🧪 TEST (GraphAPI): Force Updating LPV-100-24...\n");

  const query = container.resolve("query") as any;

  // 1. Find the variant
  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: ["id", "sku", "weight", "length", "width", "height"],
    filters: {
      sku: ["LPV-100-24"],
    },
  });

  if (variants.length === 0) {
    console.log("❌ Variant LPV-100-24 not found!");
    return;
  }

  const variant = variants[0];
  console.log(`✅ Found Variant: ${variant.id} (SKU: ${variant.sku})`);
  console.log("   Old Spec:", {
    weight: variant.weight,
    length: variant.length,
    width: variant.width,
    height: variant.height,
  });

  // 2. Update with hardcoded test values
  console.log("\n🛠 Updating with TEST values via Graph API...");

  // Using medusa workflow or service?
  // Actually, query.graph is read-only usually? Or supports mutations?
  // Wait, query.graph is for fetching. We need a service/workflow for mutation.
  // But 'medusa exec' context has access to services.

  // Let's use the product module service again but fetch via ID (safe)
  const productModuleService = container.resolve("product"); // "product" main service

  try {
    await productModuleService.updateProductVariants([
      {
        id: variant.id,
        weight: 50,
        length: 10,
        width: 10,
        height: 10,
        metadata: {
          test_sync: "true",
          shipping_weight: 50,
        },
      },
    ]);
    console.log("✅ Update command executed.");
  } catch (e) {
    console.error("❌ Update failed:", e);
  }

  // 3. Verify
  const { data: updatedVars } = await query.graph({
    entity: "product_variant",
    fields: ["id", "weight", "length", "width", "height"],
    filters: { id: variant.id },
  });

  const updated = updatedVars[0];
  console.log("\n✅ Update Complete. New Spec in DB:");
  console.log({
    weight: updated.weight,
    length: updated.length,
    width: updated.width,
    height: updated.height,
  });
}
