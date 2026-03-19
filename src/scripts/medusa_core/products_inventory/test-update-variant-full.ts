import { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

/**
 * Force update LPV-100-24 with FULL payload (dimensions + metadata)
 * Run with: npx medusa exec ./src/scripts/test-update-variant-full.ts
 */
export default async function testUpdateVariantFull({ container }: ExecArgs) {
    console.log("\n🧪 TEST (Full): Force Updating LPV-100-24...\n");

    const productModuleService = container.resolve(Modules.PRODUCT);
    const query = container.resolve("query") as any;

    // 1. Find ID
    const { data: variants } = await query.graph({
        entity: "product_variant",
        fields: ["id", "sku"],
        filters: { sku: ["LPV-100-24"] }
    });

    if (!variants.length) {
        console.log("❌ Not found");
        return;
    }
    const variantId = variants[0].id;

    // 2. Update Dimensions + Metadata
    console.log(`🛠 Updating ID ${variantId} with full specs...`);

    try {
        await productModuleService.updateProductVariants(variantId, {
            weight: 1.3125,
            length: 9,
            width: 3,
            height: 2,
            metadata: {
                shipping_synced: "true",
                shipping_weight: 1.3125,
                shipping_length: 9,
                shipping_width: 3,
                shipping_height: 2
            }
        });
        console.log("✅ Update executed.");
    } catch (e) {
        console.error("❌ Full Update Failed:", e);
    }

    // 3. Verify
    const { data: verify } = await query.graph({
        entity: "product_variant",
        fields: ["weight", "length", "width", "height", "metadata"],
        filters: { id: variantId }
    });
    console.log("   New Specs:", verify[0]);
}
