import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { Modules } from "@medusajs/utils";

import { syncProductToMeiliSearchWorkflow } from "../workflows/sync-product-meilisearch";

/**
 * AUTO-SET THUMBNAIL + MEILISEARCH SYNC ON PRODUCT UPDATE
 *
 * Fires on every product.updated event. Does two things:
 *
 * 1. Thumbnail auto-assign: If the product has images but thumbnail = null,
 *    sets thumbnail to the first image (rank=0). This covers the case where
 *    a user uploads images via the admin Media section without explicitly
 *    clicking "Set as thumbnail".
 *
 * 2. Meilisearch sync: Syncs the product to Meilisearch immediately so the
 *    products-advanced page shows the updated thumbnail without waiting for
 *    the next inventory sync re-index cycle.
 */
export default async function productThumbnailSyncSubscriber({
  event,
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve("logger");
  const productService = container.resolve(Modules.PRODUCT);
  const query = container.resolve("query");

  const productId: string = event.data?.id;
  if (!productId) return;

  try {
    // Fetch product with images
    const { data: products } = await query.graph({
      entity: "product",
      fields: ["id", "title", "thumbnail", "images.url", "images.rank"],
      filters: { id: productId },
    });

    const product = products[0];
    if (!product) return;

    // 1. Auto-set thumbnail if missing but images exist
    if (!product.thumbnail && product.images && product.images.length > 0) {
      const sorted = [...product.images].sort(
        (a: any, b: any) => (a.rank ?? 0) - (b.rank ?? 0)
      );
      const firstImageUrl: string = sorted[0]!.url;

      await productService.updateProducts(productId, {
        thumbnail: firstImageUrl,
      });

      logger.info(
        `[ProductThumbnailSync] ✅ Auto-set thumbnail for "${product.title}": ${firstImageUrl}`
      );
    }

    // 2. Sync to Meilisearch immediately (non-blocking — errors don't fail the event)
    try {
      await syncProductToMeiliSearchWorkflow(container).run({
        input: { productId },
      });
      logger.info(
        `[ProductThumbnailSync] ✅ Meilisearch synced for "${product.title}"`
      );
    } catch (meiliErr: any) {
      logger.warn(
        `[ProductThumbnailSync] ⚠️ Meilisearch sync failed (thumbnail still saved): ${meiliErr.message}`
      );
    }
  } catch (err: any) {
    logger.error(
      `[ProductThumbnailSync] ❌ Error for product ${productId}: ${err.message}`
    );
  }
}

export const config: SubscriberConfig = {
  event: "product.updated",
};
