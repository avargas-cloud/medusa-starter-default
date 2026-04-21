import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { Modules } from "@medusajs/utils";

import { syncInventoryItemToMeiliSearchWorkflow } from "../workflows/sync-inventory-item-meilisearch";
import { syncProductToMeiliSearchWorkflow } from "../workflows/sync-product-meilisearch";

/**
 * PRODUCT LIFECYCLE → THUMBNAIL + MEILISEARCH SYNC
 *
 * Fires on product.created / product.updated / product.deleted.
 *
 *  • product.created  → sync new product to MeiliSearch `products` index.
 *  • product.updated  → auto-set thumbnail (first image when thumbnail is
 *                       missing) AND sync to MeiliSearch.
 *  • product.deleted  → remove the document from MeiliSearch `products`.
 *
 * Without the created/deleted listeners, freshly created products were
 * invisible in the advanced search page until the first edit, and deleted
 * products lingered in the index until a full re-sync.
 */
export default async function productMeilisearchSyncSubscriber({
  event,
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve("logger");

  const productId: string = event.data?.id;
  if (!productId) return;

  // DELETE path — remove from BOTH the `products` index and the `inventory`
  // index. The inventory cleanup uses the incremental workflow's search-by-
  // productId fallback because the variant rows are already gone from the DB.
  if (event.name === "product.deleted") {
    try {
      const { MeiliSearch } = await import("meilisearch");
      const client = new MeiliSearch({
        host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
        apiKey: process.env.MEILISEARCH_API_KEY || "",
      });
      await client.index("products").deleteDocument(productId);
      logger.info(
        `[ProductMeilisearchSync] 🗑️  Deleted from products index: ${productId}`
      );
    } catch (err: any) {
      logger.warn(
        `[ProductMeilisearchSync] ⚠️ products index delete failed for ${productId}: ${err.message}`
      );
    }

    try {
      const { result } = await syncInventoryItemToMeiliSearchWorkflow(
        container
      ).run({ input: { productId, deleteWhenMissing: true } });
      logger.info(
        `[ProductMeilisearchSync] 🗑️  inventory index cleanup for ${productId} — deleted=${result.deleted}`
      );
    } catch (err: any) {
      logger.warn(
        `[ProductMeilisearchSync] ⚠️ inventory cleanup failed for ${productId}: ${err.message}`
      );
    }
    return;
  }

  // CREATE / UPDATE path — fetch fresh DB data, upsert to Meili.
  const productService = container.resolve(Modules.PRODUCT);
  const query = container.resolve("query");

  try {
    const { data: products } = await query.graph({
      entity: "product",
      fields: ["id", "title", "thumbnail", "images.url", "images.rank"],
      filters: { id: productId },
    });

    const product = products[0];
    if (!product) return;

    // Thumbnail auto-assign — only meaningful on update when an image was
    // uploaded without the user explicitly setting the thumbnail.
    if (
      event.name === "product.updated" &&
      !product.thumbnail &&
      product.images &&
      product.images.length > 0
    ) {
      const sorted = [...product.images].sort(
        (a: any, b: any) => (a.rank ?? 0) - (b.rank ?? 0)
      );
      const firstImageUrl: string = sorted[0]!.url;

      await productService.updateProducts(productId, {
        thumbnail: firstImageUrl,
      });

      logger.info(
        `[ProductMeilisearchSync] ✅ Auto-set thumbnail for "${product.title}": ${firstImageUrl}`
      );
    }

    try {
      await syncProductToMeiliSearchWorkflow(container).run({
        input: { productId },
      });
      logger.info(
        `[ProductMeilisearchSync] ✅ Meili synced (${event.name}) for "${product.title}"`
      );
    } catch (meiliErr: any) {
      logger.warn(
        `[ProductMeilisearchSync] ⚠️ Meili sync failed: ${meiliErr.message}`
      );
    }
  } catch (err: any) {
    logger.error(
      `[ProductMeilisearchSync] ❌ Error for product ${productId}: ${err.message}`
    );
  }
}

export const config: SubscriberConfig = {
  event: ["product.created", "product.updated", "product.deleted"],
};
