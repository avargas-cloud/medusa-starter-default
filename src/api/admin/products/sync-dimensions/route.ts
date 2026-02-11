import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/framework/utils";
import WooCommerceRestApi from "@woocommerce/woocommerce-rest-api";

/**
 * POST /admin/products/sync-dimensions
 * 
 * Syncs product dimensions and weights from WooCommerce to Medusa
 * Matches products using metadata.woocommerce_id
 */
export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    try {
        // Initialize WooCommerce API
        const WooCommerce = new WooCommerceRestApi({
            url: process.env.WC_URL!,
            consumerKey: process.env.WC_CONSUMER_KEY!,
            consumerSecret: process.env.WC_CONSUMER_SECRET!,
            version: "wc/v3"
        });

        console.log("[Sync Dimensions] Fetching WooCommerce products...");

        // Fetch all WC products with pagination
        const wcProducts = [];
        let page = 1;
        let hasMore = true;

        while (hasMore && page <= 10) { // Safety limit: 10 pages = 1000 products max
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

            console.log(`[Sync Dimensions] Page ${page}: ${products.length} products`);
            hasMore = products.length === 100;
            page++;
        }

        console.log(`[Sync Dimensions] Found ${wcProducts.length} WC products with dimensions`);

        // Fetch Medusa products
        const productService = req.scope.resolve(Modules.PRODUCT);
        const medusaProducts = await productService.listProducts({}, {
            take: 1000
        });

        console.log(`[Sync Dimensions] Found ${medusaProducts.length} Medusa products`);

        // Match and update VARIANTS (not products)
        const updates = [];
        const matchedVariants = [];
        let skippedCount = 0;

        for (const wcProduct of wcProducts) {
            // Find Medusa product that contains a variant with this WC product's SKU
            const medusaProduct = medusaProducts.find((p: any) =>
                p.variants?.some((v: any) => v.sku === wcProduct.sku)
            );

            if (!medusaProduct) {
                skippedCount++;
                continue;
            }

            // Find the specific variant with matching SKU
            const variant = medusaProduct.variants?.find((v: any) => v.sku === wcProduct.sku);

            if (!variant) {
                skippedCount++;
                continue;
            }

            matchedVariants.push({
                variant_id: variant.id,
                product_id: medusaProduct.id,
                sku: wcProduct.sku,
                title: `${medusaProduct.title} - ${variant.title || ''}`,
                dimensions: {
                    length: parseFloat(wcProduct.length) || undefined,
                    width: parseFloat(wcProduct.width) || undefined,
                    height: parseFloat(wcProduct.height) || undefined,
                    weight: parseFloat(wcProduct.weight) || undefined
                }
            });

            // Update VARIANT with native Medusa v2 dimension fields
            updates.push(
                productService.updateProductVariants(variant.id, {
                    height: parseFloat(wcProduct.height) || undefined,
                    width: parseFloat(wcProduct.width) || undefined,
                    length: parseFloat(wcProduct.length) || undefined,
                    weight: parseFloat(wcProduct.weight) || undefined
                })
            );
        }

        // Execute all updates
        await Promise.all(updates);

        console.log(`[Sync Dimensions] ✅ Updated ${updates.length} variants`);

        res.json({
            success: true,
            wc_products_count: wcProducts.length,
            medusa_products_count: medusaProducts.length,
            matched_count: matchedVariants.length,
            updated_count: updates.length,
            skipped_count: skippedCount,
            variants: matchedVariants
        });

    } catch (error) {
        console.error("[Sync Dimensions] Error:", error);
        res.status(500).json({
            error: "Failed to sync dimensions from WooCommerce",
            details: error instanceof Error ? error.message : String(error)
        });
    }
}
