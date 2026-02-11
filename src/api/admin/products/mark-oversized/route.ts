import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/framework/utils";

/**
 * POST /admin/products/mark-oversized
 * 
 * Marks LED Channels products (EAP-*-8S/8W/8B) as oversized for shipping
 */
export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    try {
        const productService = req.scope.resolve(Modules.PRODUCT);

        // Fetch ALL products with their variants
        const products = await productService.listProducts({}, {
            relations: ["variants"],
            take: 1000 // Adjust if you have more products
        });

        console.log(`[Mark Oversized] Found ${products.length} total products`);

        // Pattern: EAP-*-8S, EAP-*-8W, EAP-*-8B (LED Channels SKUs)
        const oversizedPattern = /^EAP-.*-8[SWB]$/i;

        const updates = [];
        const matchedProducts = [];

        for (const product of products) {
            // Check if any variant has an oversized SKU
            const hasOversizedSKU = product.variants?.some((variant: any) => {
                const sku = variant.sku || '';
                return oversizedPattern.test(sku);
            });

            if (hasOversizedSKU) {
                const sampleSKU = product.variants?.find((v: any) =>
                    oversizedPattern.test(v.sku || '')
                )?.sku;

                matchedProducts.push({
                    id: product.id,
                    handle: product.handle,
                    title: product.title,
                    sample_sku: sampleSKU
                });

                // Update product metadata
                updates.push(
                    productService.updateProducts(product.id, {
                        metadata: {
                            shipping_type: "oversized"
                        }
                    })
                );
            }
        }

        console.log(`[Mark Oversized] Matched ${matchedProducts.length} LED Channels products (by SKU)`);

        // Execute all updates
        await Promise.all(updates);

        console.log(`[Mark Oversized] ✅ Updated ${updates.length} products`);

        res.json({
            success: true,
            matched_count: matchedProducts.length,
            updated_count: updates.length,
            products: matchedProducts
        });

    } catch (error) {
        console.error("[Mark Oversized] Error:", error);
        res.status(500).json({
            error: "Failed to mark oversized products",
            details: error instanceof Error ? error.message : String(error)
        });
    }
}
