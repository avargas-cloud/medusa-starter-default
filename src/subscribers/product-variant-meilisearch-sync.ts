import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";

import { syncInventoryItemToMeiliSearchWorkflow } from "../workflows/sync-inventory-item-meilisearch";

/**
 * VARIANT LIFECYCLE → MEILISEARCH SYNC
 *
 * Medusa core emits these events from the variant workflows:
 *   • product-variant.created
 *   • product-variant.updated
 *   • product-variant.deleted
 *
 * The existing product-lifecycle subscriber already covers the common case
 * where variants change as part of a product update (product.updated also
 * fires and cascades both indexes). This subscriber adds coverage for the
 * variant-only workflows — `createProductVariantsWorkflow`,
 * `updateProductVariantsWorkflow`, `deleteProductVariantsWorkflow` — which
 * do NOT emit product.updated.
 *
 * Event payload: `{ id }` or `{ id: string[] }` — the variant id(s) that
 * were mutated. For deletions we delegate the Meili doc removal to the
 * incremental workflow using the `deleteWhenMissing` flag so orphaned
 * inventory_item docs also get cleaned.
 */
export default async function productVariantMeilisearchSyncSubscriber({
  event,
  container,
}: SubscriberArgs<{ id: string | string[] }>) {
  const logger = container.resolve("logger");

  const rawId = event.data?.id;
  if (!rawId) return;
  const variantIds = Array.isArray(rawId) ? rawId : [rawId];

  const isDelete = event.name === "product-variant.deleted";

  for (const variantId of variantIds) {
    try {
      const { result } = await syncInventoryItemToMeiliSearchWorkflow(
        container
      ).run({
        input: {
          variantId,
          deleteWhenMissing: isDelete,
        },
      });
      logger.info(
        `[VariantMeilisearchSync] ${event.name} ${variantId} — synced=${result.synced} deleted=${result.deleted}`
      );
    } catch (err: any) {
      logger.warn(
        `[VariantMeilisearchSync] ⚠️ ${event.name} ${variantId} failed: ${err.message}`
      );
    }
  }
}

export const config: SubscriberConfig = {
  event: [
    "product-variant.created",
    "product-variant.updated",
    "product-variant.deleted",
  ],
};
