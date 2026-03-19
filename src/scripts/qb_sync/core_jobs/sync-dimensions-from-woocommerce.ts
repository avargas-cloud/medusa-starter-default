import { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";
import WooCommerceRestApi from "@woocommerce/woocommerce-rest-api";

/**
 * Sync product dimensions from WooCommerce to Medusa variant fields (Native Fields Only)
 * 
 * fixes:
 *  - Increases pagination to catch all products (LPV-100-24)
 *  - Uses ProductModuleService for robust updates of variant native fields
 *  - Parent-to-child dimension propagation logic
 * 
 * Run with: npx medusa exec ./src/scripts/sync-dimensions-from-woocommerce.ts
 */
export default async function syncDimensions({ container }: ExecArgs) {
    const query = container.resolve("query");
    const productModuleService = container.resolve(Modules.PRODUCT);

    console.log("\n🔄 [Dimension Sync - Native Fields] Starting...\n");

    const wcProducts: any[] = [];

    try {
        // Initialize WooCommerce API
        const WooCommerce = new WooCommerceRestApi({
            url: process.env.WC_URL!,
            consumerKey: process.env.WC_CONSUMER_KEY!,
            consumerSecret: process.env.WC_CONSUMER_SECRET!,
            version: "wc/v3"
        });

        console.log("📦 Fetching WooCommerce products...");

        // Helper to process a WC product/variation and add to list
        const processWcProduct = (p: any, type: 'simple' | 'variable' | 'variation') => {
            if (p.sku && (p.dimensions || p.weight)) {
                // Check if any dimension is actually set
                const hasDimensions = p.dimensions?.length || p.dimensions?.width || p.dimensions?.height || p.weight;

                if (hasDimensions) {
                    wcProducts.push({
                        id: p.id,
                        sku: p.sku,
                        title: p.name || p.title || '',
                        type,
                        slug: p.slug, // Important for handle matching
                        length: p.dimensions?.length || "",
                        width: p.dimensions?.width || "",
                        height: p.dimensions?.height || "",
                        weight: p.weight || ""
                    });
                }
            }
        };

        let page = 1;
        let hasMore = true;

        // Fetch loop (LIMIT 100 pages = 5000 products)
        while (hasMore && page <= 100) {
            const response = await WooCommerce.get("products", {
                per_page: 50, // Max per page
                page: page
            });

            const products = response.data;

            for (const product of products) {
                if (product.type === 'simple') {
                    processWcProduct(product, 'simple');
                }
                else if (product.type === 'variable') {
                    // Parent usage as fallback
                    if (product.dimensions?.length || product.dimensions?.width || product.dimensions?.height || product.weight) {
                        processWcProduct(product, 'variable');
                    }

                    // Variations
                    try {
                        const variationsReq = await WooCommerce.get(`products/${product.id}/variations`, {
                            per_page: 50
                        });
                        const variations = variationsReq.data;
                        for (const variation of variations) {
                            processWcProduct({
                                ...variation,
                                title: `${product.name} - ${variation.attributes?.map((a: any) => a.option).join(' ')}`
                            }, 'variation');
                        }
                    } catch (e) {
                        console.error(`   ⚠ Failed to fetch variations for ${product.id}`);
                    }
                }
            }

            if (page % 5 === 0) console.log(`   Page ${page}: Processed ${products.length} items...`);
            hasMore = products.length === 50;
            page++;
        }

        console.log(`✓ Found ${wcProducts.length} WC items to sync\n`);

        // Fetch Medusa products
        const { data: medusaProducts } = await query.graph({
            entity: "product",
            fields: ["id", "title", "handle", "variants.id", "variants.sku"],
            pagination: { take: 10000 } // Increased check limit
        });

        console.log(`✓ Found ${medusaProducts.length} Medusa products\n`);

        let updatedCount = 0;
        let skippedCount = 0;

        console.log("🛠 Processing updates...");

        for (const wcProduct of wcProducts) {
            let variantsToUpdate: any[] = [];
            let medusaProduct = null;

            // 1. Exact SKU match on variant
            medusaProduct = medusaProducts.find((p: any) =>
                p.variants?.some((v: any) => v.sku === wcProduct.sku)
            );

            if (medusaProduct) {
                const variant = medusaProduct.variants?.find((v: any) => v.sku === wcProduct.sku);
                if (variant) {
                    variantsToUpdate.push({ variant, productTitle: medusaProduct.title });
                }
            } else {
                // 2. Parent Match (Handle/Title) -> Update All Variants
                medusaProduct = medusaProducts.find((p: any) =>
                    p.handle === wcProduct.slug ||
                    p.title === wcProduct.title
                );

                if (medusaProduct && medusaProduct.variants?.length > 0) {
                    variantsToUpdate = medusaProduct.variants.map((v: any) => ({
                        variant: v,
                        productTitle: medusaProduct.title
                    }));
                }
            }

            if (variantsToUpdate.length === 0) {
                skippedCount++;
                continue;
            }

            // Parse numerical values
            // Ensure they are numbers, fallback to 0 if invalid
            const weight = parseFloat(wcProduct.weight);
            const length = parseFloat(wcProduct.length);
            const width = parseFloat(wcProduct.width);
            const height = parseFloat(wcProduct.height);

            // Skip if all are invalid/zero/NaN
            const isValid = (n: number) => !isNaN(n) && n > 0;
            if (!isValid(weight) && !isValid(length) && !isValid(width) && !isValid(height)) {
                continue;
            }

            const updatePayload: any = {};
            if (isValid(weight)) updatePayload.weight = weight;
            if (isValid(length)) updatePayload.length = length;
            if (isValid(width)) updatePayload.width = width;
            if (isValid(height)) updatePayload.height = height;

            for (const { variant } of variantsToUpdate) {
                try {
                    // Update Native Fields ONLY
                    await productModuleService.updateProductVariants(variant.id, updatePayload);

                    if (updatedCount % 50 === 0 && updatedCount > 0) process.stdout.write("."); // Progress dot
                    updatedCount++;
                } catch (e) {
                    console.error(`\n  ❌ Failed to update ${variant.sku}:`, e);
                }
            }
        }

        console.log(`\n${"=".repeat(60)}`);
        console.log(`✅ SYNC COMPLETE!`);
        console.log(`  Updated variants: ${updatedCount}`);
        console.log(`  Skipped: ${skippedCount}`);
        console.log(`${"=".repeat(60)}\n`);

    } catch (error) {
        console.error("\n❌ Error:", error);
    }
}
