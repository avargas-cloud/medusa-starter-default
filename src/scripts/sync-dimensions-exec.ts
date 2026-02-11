/**
 * Sync product dimensions from WooCommerce to Medusa variants
 * Run: npx medusa exec ./src/scripts/sync-dimensions-exec.ts
 */

import { Modules } from "@medusajs/framework/utils";
import WooCommerceRestApi from "@woocommerce/woocommerce-rest-api";

export default async function syncDimensions({ container }: any) {
    console.log("\n🔄 [Dimension Sync] Starting...\n");

    try {
        const WooCommerce = new WooCommerceRestApi({
            url: process.env.WC_URL!,
            consumerKey: process.env.WC_CONSUMER_KEY!,
            consumerSecret: process.env.WC_CONSUMER_SECRET!,
            version: "wc/v3"
        });

        console.log("📦 [Dimension Sync] Fetching WooCommerce products...");

        const wcProducts: any[] = [];
        let page = 1;
        let hasMore = true;

        while (hasMore && page <= 10) {
            const response = await WooCommerce.get("products", {
                per_page: 100,
                page: page
            });

            const products = response.data;

            for (const product of products) {
                if (product.sku && (product.dimensions || product.weight)) {
                    wcProducts.push({
                        id: product.id,
                        sku: product.sku,
                        title: product.name,
                        length: product.dimensions?.length || "",
                        width: product.dimensions?.width || "",
                        height: product.dimensions?.height || "",
                        weight: product.weight || ""
                    });
                }
            }

            console.log(`   Page ${page}: ${products.length} products`);
            hasMore = products.length === 100;
            page++;
        }

        console.log(`\n✓ Found ${wcProducts.length} WC products with dimensions\n`);

        const productService = container.resolve(Modules.PRODUCT);
        const medusaProducts = await productService.listProducts({}, {
            relations: ["variants"],
            take: 1000
        });

        console.log(`✓ Found ${medusaProducts.length} Medusa products\n`);

        const updates = [];
        const matchedVariants = [];
        let skippedCount = 0;

        for (const wcProduct of wcProducts) {
            const medusaProduct = medusaProducts.find((p: any) =>
                p.variants?.some((v: any) => v.sku === wcProduct.sku)
            );

            if (!medusaProduct) {
                skippedCount++;
                continue;
            }

            const variant = medusaProduct.variants?.find((v: any) => v.sku === wcProduct.sku);

            if (!variant) {
                skippedCount++;
                continue;
            }

            matchedVariants.push({
                variant_id: variant.id,
                sku: wcProduct.sku,
                title: `${medusaProduct.title}`,
                dimensions: {
                    length: parseFloat(wcProduct.length) || undefined,
                    width: parseFloat(wcProduct.width) || undefined,
                    height: parseFloat(wcProduct.height) || undefined,
                    weight: parseFloat(wcProduct.weight) || undefined
                }
            });

            updates.push(
                productService.updateProductVariants(variant.id, {
                    height: parseFloat(wcProduct.height) || undefined,
                    width: parseFloat(wcProduct.width) || undefined,
                    length: parseFloat(wcProduct.length) || undefined,
                    weight: parseFloat(wcProduct.weight) || undefined
                })
            );
        }

        console.log(`🔄 Updating ${updates.length} variants...`);
        await Promise.all(updates);

        console.log(`\n${"=".repeat(60)}`);
        console.log(`✅ SYNC COMPLETE!`);
        console.log(`${"=".repeat(60)}`);
        console.log(`  Matched variants: ${matchedVariants.length}`);
        console.log(`  Updated variants: ${updates.length}`);
        console.log(`  Skipped: ${skippedCount}`);
        console.log(`${"=".repeat(60)}`);

        if (matchedVariants.length > 0) {
            console.log(`\n📊 Sample updated variants (first 5):`);
            matchedVariants.slice(0, 5).forEach((v: any) => {
                console.log(`\n  ✓ ${v.sku}: ${v.title}`);
                if (v.dimensions.length) console.log(`    Length: ${v.dimensions.length}"`);
                if (v.dimensions.width) console.log(`    Width: ${v.dimensions.width}"`);
                if (v.dimensions.height) console.log(`    Height: ${v.dimensions.height}"`);
                if (v.dimensions.weight) console.log(`    Weight: ${v.dimensions.weight} lb`);
            });
        }

        console.log(`\n✅ All done!\n`);

    } catch (error) {
        console.error("\n❌ [Dimension Sync] Error:", error);
        throw error;
    }
}
