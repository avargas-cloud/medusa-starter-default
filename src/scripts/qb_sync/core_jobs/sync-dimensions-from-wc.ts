/**
 * Export product dimensions and weights from WooCommerce
 * Then sync to Medusa product metadata
 * 
 * Run: npx tsx src/scripts/sync-dimensions-from-wc.ts
 */

import WooCommerceRestApi from "@woocommerce/woocommerce-rest-api";
import { Modules } from "@medusajs/utils";
import * as dotenv from "dotenv";

dotenv.config();

// WooCommerce API client
const WooCommerce = new WooCommerceRestApi({
    url: process.env.WC_URL!,
    consumerKey: process.env.WC_CONSUMER_KEY!,
    consumerSecret: process.env.WC_CONSUMER_SECRET!,
    version: "wc/v3"
});

interface WCProductDimensions {
    sku: string;
    title: string;
    length: string;
    width: string;
    height: string;
    weight: string;
}

async function main() {
    console.log("[Sync Dimensions] Starting...\n");

    // Step 1: Fetch all products from WooCommerce with dimensions
    console.log("[WooCommerce] Fetching products...");

    const wcProducts: WCProductDimensions[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
        const response = await WooCommerce.get("products", {
            per_page: 100,
            page: page
        });

        const products = response.data;

        for (const product of products) {
            if (product.sku && (product.dimensions || product.weight)) {
                wcProducts.push({
                    sku: product.sku,
                    title: product.name,
                    length: product.dimensions?.length || "",
                    width: product.dimensions?.width || "",
                    height: product.dimensions?.height || "",
                    weight: product.weight || ""
                });
            }
        }

        hasMore = products.length === 100;
        page++;
    }

    console.log(`[WooCommerce] Found ${wcProducts.length} products with dimensions/weight\n`);

    // Step 2: Save to JSON file for review
    const fs = await import('fs/promises');
    await fs.writeFile(
        './wc-product-dimensions.json',
        JSON.stringify(wcProducts, null, 2)
    );
    console.log("✅ Saved to ./wc-product-dimensions.json\n");

    // Step 3: Update Medusa products
    console.log("[Medusa] Updating products with dimensions...\n");

    // Import Medusa dynamically to avoid initialization issues
    const { default: { MedusaAppLoader } } = await import("@medusajs/framework");
    const loader = new MedusaAppLoader();
    const container = await loader.load();
    const productService = container.resolve(Modules.PRODUCT);

    // Fetch all Medusa products with variants
    const medusaProducts = await productService.listProducts({}, {
        relations: ["variants"],
        take: 1000
    });

    let updatedCount = 0;
    let skippedCount = 0;

    for (const wcProduct of wcProducts) {
        // Find matching Medusa product by SKU
        const medusaProduct = medusaProducts.find(p =>
            p.variants?.some((v: any) => v.sku === wcProduct.sku)
        );

        if (!medusaProduct) {
            console.log(`⚠️  SKU not found in Medusa: ${wcProduct.sku}`);
            skippedCount++;
            continue;
        }

        // Update product metadata with dimensions
        await productService.updateProducts(medusaProduct.id, {
            metadata: {
                ...medusaProduct.metadata,
                // Keep existing shipping_type if present
                package_length_in: parseFloat(wcProduct.length) || 0,
                package_width_in: parseFloat(wcProduct.width) || 0,
                package_height_in: parseFloat(wcProduct.height) || 0,
                package_weight_lb: parseFloat(wcProduct.weight) || 0
            }
        });

        console.log(`✓ Updated: ${wcProduct.sku} - ${wcProduct.title}`);
        console.log(`  Dimensions: ${wcProduct.length}" x ${wcProduct.width}" x ${wcProduct.height}", Weight: ${wcProduct.weight} lb`);
        updatedCount++;
    }

    console.log(`\n[Sync Dimensions] ✅ Complete!`);
    console.log(`- WooCommerce products: ${wcProducts.length}`);
    console.log(`- Medusa updated: ${updatedCount}`);
    console.log(`- Skipped (not found): ${skippedCount}`);

    process.exit(0);
}

main().catch(error => {
    console.error("[Sync Dimensions] Fatal error:", error);
    process.exit(1);
});
