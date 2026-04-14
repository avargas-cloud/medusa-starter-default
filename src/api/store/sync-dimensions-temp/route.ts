import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/utils";
import WooCommerceRestApi from "@woocommerce/woocommerce-rest-api";

/**
 * POST /store/sync-dimensions-temp
 *
 * TEMPORARY public endpoint for one-time dimension migration
 * TODO: Remove this after migration is complete
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  try {
    const WooCommerce = new WooCommerceRestApi({
      url: process.env.WC_URL!,
      consumerKey: process.env.WC_CONSUMER_KEY!,
      consumerSecret: process.env.WC_CONSUMER_SECRET!,
      version: "wc/v3",
    });

    console.log("[Sync Dimensions] Fetching WooCommerce products...");

    const wcProducts = [];
    let page = 1;
    let hasMore = true;

    while (hasMore && page <= 10) {
      const response = await WooCommerce.get("products", {
        per_page: 100,
        page: page,
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
            weight: product.weight || "",
          });
        }
      }

      console.log(
        `[Sync Dimensions] Page ${page}: ${products.length} products`
      );
      hasMore = products.length === 100;
      page++;
    }

    console.log(
      `[Sync Dimensions] Found ${wcProducts.length} WC products with dimensions`
    );

    const productService = req.scope.resolve(Modules.PRODUCT);
    const medusaProducts = await productService.listProducts(
      {},
      {
        relations: ["variants"],
        take: 1000,
      }
    );

    console.log(
      `[Sync Dimensions] Found ${medusaProducts.length} Medusa products`
    );

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

      const variant = medusaProduct.variants?.find(
        (v: any) => v.sku === wcProduct.sku
      );

      if (!variant) {
        skippedCount++;
        continue;
      }

      matchedVariants.push({
        variant_id: variant.id,
        sku: wcProduct.sku,
        dimensions: {
          length: parseFloat(wcProduct.length) || undefined,
          width: parseFloat(wcProduct.width) || undefined,
          height: parseFloat(wcProduct.height) || undefined,
          weight: parseFloat(wcProduct.weight) || undefined,
        },
      });

      updates.push(
        productService.updateProductVariants(variant.id, {
          height: parseFloat(wcProduct.height) || undefined,
          width: parseFloat(wcProduct.width) || undefined,
          length: parseFloat(wcProduct.length) || undefined,
          weight: parseFloat(wcProduct.weight) || undefined,
        })
      );
    }

    await Promise.all(updates);

    console.log(`[Sync Dimensions] ✅ Updated ${updates.length} variants`);

    res.json({
      success: true,
      matched_count: matchedVariants.length,
      updated_count: updates.length,
      skipped_count: skippedCount,
      variants: matchedVariants.slice(0, 10), // Solo primeros 10 para no saturar
    });
  } catch (error) {
    console.error("[Sync Dimensions] Error:", error);
    res.status(500).json({
      error: "Failed to sync dimensions",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}
