import { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

/**
 * Force update the dimensions of LPV-100-24 to test if they appear in Admin
 * Run with: npx medusa exec ./src/scripts/test-update-variant.ts
 */
export default async function testUpdateVariant({ container }: ExecArgs) {
    console.log("\n🧪 TEST: Force Updating LPV-100-24...\n");

    const productModuleService = container.resolve(Modules.PRODUCT);

    // 1. Find the variant
    const variants = await productModuleService.listProductVariants({
        sku: "LPV-100-24"
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
        height: variant.height
    });

    // 2. Update with hardcoded test values
    console.log("\n🛠 Updating with TEST values (10x10x10, 50lb)...");

    await productModuleService.updateProductVariants([
        {
            id: variant.id,
            weight: 50,
            length: 10,
            width: 10,
            height: 10,
            // Also update metadata just in case Admin reads from there (some setups do)
            metadata: {
                test_sync: "true",
                shipping_weight: 50,
                shipping_length: 10,
                shipping_width: 10,
                shipping_height: 10
            }
        }
    ]);

    // 3. Verify
    const updated = await productModuleService.retrieveProductVariant(variant.id);
    console.log("\n✅ Update Complete. New Spec in DB:");
    console.log({
        weight: updated.weight,
        length: updated.length,
        width: updated.width,
        height: updated.height,
        metadata: updated.metadata
    });

    console.log("\n👉 Please check Medusa Admin for LPV-100-24 now.");
}
