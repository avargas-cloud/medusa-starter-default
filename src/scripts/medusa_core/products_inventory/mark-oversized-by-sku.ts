/**
 * Simple script to mark LED Channels products as oversized
 * Based on SKU pattern: EAP-*-8S, EAP-*-8W, EAP-*-8B
 * 
 * Run: npx tsx src/scripts/mark-oversized-by-sku.ts
 */

import { Modules } from "@medusajs/utils";
import { initialize } from "@medusajs/framework";

async function main() {
    console.log("[Mark Oversized] Initializing Medusa...");

    const { container } = await initialize();
    const productService = container.resolve(Modules.PRODUCT);

    console.log("[Mark Oversized] Fetching all products...");

    // Fetch all products with variants (to get SKUs)
    const products = await productService.listProducts({}, {
        relations: ["variants"],
        take: 1000
    });

    console.log(`[Mark Oversized] Found ${products.length} total products`);

    // Pattern: EAP-*-8S, EAP-*-8W, EAP-*-8B (LED Channels)
    const oversizedPattern = /^EAP-.*-8[SWB]$/i;

    const matchedProducts = [];

    for (const product of products) {
        // Check if any variant has an oversized SKU
        const hasOversizedSKU = product.variants?.some(variant => {
            const sku = variant.sku || '';
            return oversizedPattern.test(sku);
        });

        if (hasOversizedSKU) {
            const sampleSKU = product.variants?.find(v => oversizedPattern.test(v.sku || ''))?.sku;

            matchedProducts.push({
                id: product.id,
                handle: product.handle,
                title: product.title,
                sample_sku: sampleSKU
            });
        }
    }

    console.log(`\n[Mark Oversized] ✅ Matched ${matchedProducts.length} products with pattern EAP-*-8[SWB]`);
    console.log(`\nMatched products:`);
    matchedProducts.forEach(p => {
        console.log(`  - ${p.sample_sku}: ${p.title} (handle: ${p.handle})`);
    });

    // Update products
    console.log(`\n[Mark Oversized] Updating ${matchedProducts.length} products...`);

    for (const product of matchedProducts) {
        try {
            await productService.updateProducts(product.id, {
                metadata: {
                    shipping_type: "oversized"
                }
            });
            console.log(`  ✓ Updated: ${product.sample_sku}`);
        } catch (error) {
            console.error(`  ✗ Failed to update ${product.sample_sku}:`, error);
        }
    }

    console.log(`\n[Mark Oversized] ✅ Complete! Updated ${matchedProducts.length} products`);
    process.exit(0);
}

main().catch(error => {
    console.error("[Mark Oversized] Fatal error:", error);
    process.exit(1);
});
