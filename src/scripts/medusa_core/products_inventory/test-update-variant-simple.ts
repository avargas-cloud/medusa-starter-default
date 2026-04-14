import { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

/**
 * Force update LPV-100-24 with minimal payload using Product Module Service
 * Run with: npx medusa exec ./src/scripts/test-update-variant-simple.ts
 */
export default async function testUpdateVariantSimple({ container }: ExecArgs) {
  console.log("\n🧪 TEST (Simple): Force Updating LPV-100-24...\n");

  const productModuleService = container.resolve(Modules.PRODUCT);
  const query = container.resolve("query") as any;

  // 1. Find ID
  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: ["id", "sku"],
    filters: { sku: ["LPV-100-24"] },
  });

  if (!variants.length) {
    console.log("❌ Not found");
    return;
  }
  const variantId = variants[0].id;

  // 2. Update ONLY weight
  console.log(`🛠 Updating ID ${variantId} weight to 99...`);

  try {
    await productModuleService.updateProductVariants(variantId, {
      weight: 99,
    });
    console.log("✅ Update executed.");
  } catch (e) {
    console.error("❌ Single Update Failed:", e);

    // Try bulk syntax just in case
    try {
      console.log("🔄 Retrying with array syntax...");
      await productModuleService.updateProductVariants([
        { id: variantId, weight: 99 },
      ]);
      console.log("✅ Array Update executed.");
    } catch (e2) {
      console.error("❌ Array Update Failed:", e2);
    }
  }

  // 3. Verify
  const { data: verify } = await query.graph({
    entity: "product_variant",
    fields: ["weight"],
    filters: { id: variantId },
  });
  console.log("   New Weight:", verify[0].weight);
}
