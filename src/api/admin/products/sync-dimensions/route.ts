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

        // Match and update
        const updates = [];
        const matchedProducts = [];
        let skippedCount = 0;

        for (const wcProduct of wcProducts) {
            // Try to match by wc_id in metadata (this is what the products actually use)
            const medusaProduct = medusaProducts.find((p: any) =>
                p.metadata?.wc_id === wcProduct.id ||
                p.metadata?.wc_id === String(wcProduct.id)
            );

            if (!medusaProduct) {
                skippedCount++;
                continue;
            }

            matchedProducts.push({
                medusa_id: medusaProduct.id,
                wc_id: wcProduct.id,
                sku: wcProduct.sku,
                title: wcProduct.title,
                dimensions: {
                    length: parseFloat(wcProduct.length) || 0,
                    width: parseFloat(wcProduct.width) || 0,
                    height: parseFloat(wcProduct.height) || 0,
                    weight: parseFloat(wcProduct.weight) || 0
                }
            });

            // Update product
            updates.push(
                productService.updateProducts(medusaProduct.id, {
                    metadata: {
                        ...medusaProduct.metadata,
                        package_length_in: parseFloat(wcProduct.length) || 0,
                        package_width_in: parseFloat(wcProduct.width) || 0,
                        package_height_in: parseFloat(wcProduct.height) || 0,
                        package_weight_lb: parseFloat(wcProduct.weight) || 0
                    }
                })
            );
        }

        // Execute all updates
        await Promise.all(updates);

        console.log(`[Sync Dimensions] ✅ Updated ${updates.length} products`);

        res.json({
            success: true,
            wc_products_count: wcProducts.length,
            medusa_products_count: medusaProducts.length,
            matched_count: matchedProducts.length,
            updated_count: updates.length,
            skipped_count: skippedCount,
            products: matchedProducts
        });

    } catch (error) {
        console.error("[Sync Dimensions] Error:", error);
        res.status(500).json({
            error: "Failed to sync dimensions from WooCommerce",
            details: error instanceof Error ? error.message : String(error)
        });
    }
}
