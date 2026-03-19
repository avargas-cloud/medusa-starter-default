/**
 * Export product dimensions and weights from WooCommerce
 * Then sync to Medusa product metadata using woocommerce_id
 * 
 * Run: npx tsx src/scripts/sync-dimensions-v2.ts
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
    id: number;
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
        try {
            const response = await WooCommerce.get("products", {
                per_page: 100,
                page: page
            });

            const products = response.data;

            for (const product of products) {
                // Only include products with dimensions or weight
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

            console.log(`  Page ${page}: ${products.length} products`);
            hasMore = products.length === 100;
            page++;
        } catch (error) {
            console.error(`Error fetching page ${page}:`, error);
            break;
        }
    }

    console.log(`[WooCommerce] Found ${wcProducts.length} products with dimensions/weight\n`);

    // Step 2: Save to JSON file for review
    const fs = await import('fs/promises');
    await fs.writeFile(
        './wc-product-dimensions.json',
        JSON.stringify(wcProducts, null, 2)
    );
    console.log("✅ Saved backup to ./wc-product-dimensions.json\n");

    // Step 3: Update Medusa products using woocommerce_id
    console.log("[Medusa] Fetching products...");

    // Simple approach: use the API endpoint we already have
    const response = await fetch('http://localhost:9000/admin/products', {
        headers: {
            'Content-Type': 'application/json'
        }
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch Medusa products: ${response.statusText}`);
    }

    const { products: medusaProducts } = await response.json();
    console.log(`[Medusa] Found ${medusaProducts.length} products\n`);

    console.log("[Sync] Matching and updating products...\n");

    let updatedCount = 0;
    let skippedCount = 0;

    for (const wcProduct of wcProducts) {
        // Find matching Medusa product by woocommerce_id in metadata
        const medusaProduct = medusaProducts.find((p: any) =>
            p.metadata?.woocommerce_id === wcProduct.id ||
            p.metadata?.woocommerce_id === String(wcProduct.id)
        );

        if (!medusaProduct) {
            // Try fallback to SKU matching
            const medusaProductBySKU = medusaProducts.find((p: any) =>
                p.variants?.some((v: any) => v.sku === wcProduct.sku)
            );

            if (!medusaProductBySKU) {
                console.log(`⚠️  Not found: WC ID ${wcProduct.id}, SKU ${wcProduct.sku}`);
                skippedCount++;
                continue;
            }

            // Update using SKU match
            await updateProductDimensions(medusaProductBySKU.id, wcProduct);
            console.log(`✓ Updated (by SKU): ${wcProduct.sku} - ${wcProduct.title}`);
            updatedCount++;
        } else {
            // Update using woocommerce_id match
            await updateProductDimensions(medusaProduct.id, wcProduct);
            console.log(`✓ Updated (by WC ID): ${wcProduct.sku} - ${wcProduct.title}`);
            updatedCount++;
        }

        console.log(`  Dimensions: ${wcProduct.length}" x ${wcProduct.width}" x ${wcProduct.height}", Weight: ${wcProduct.weight} lb\n`);
    }

    console.log(`\n[Sync Dimensions] ✅ Complete!`);
    console.log(`- WooCommerce products: ${wcProducts.length}`);
    console.log(`- Medusa updated: ${updatedCount}`);
    console.log(`- Skipped (not found): ${skippedCount}`);

    process.exit(0);
}

async function updateProductDimensions(productId: string, wcProduct: WCProductDimensions) {
    const response = await fetch(`http://localhost:9000/admin/products/${productId}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            metadata: {
                package_length_in: parseFloat(wcProduct.length) || 0,
                package_width_in: parseFloat(wcProduct.width) || 0,
                package_height_in: parseFloat(wcProduct.height) || 0,
                package_weight_lb: parseFloat(wcProduct.weight) || 0
            }
        })
    });

    if (!response.ok) {
        throw new Error(`Failed to update product ${productId}: ${response.statusText}`);
    }
}

main().catch(error => {
    console.error("[Sync Dimensions] Fatal error:", error);
    process.exit(1);
});
