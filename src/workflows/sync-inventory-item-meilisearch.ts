import {
  createWorkflow,
  WorkflowResponse,
  createStep,
  StepResponse,
} from "@medusajs/framework/workflows-sdk";
import { Modules } from "@medusajs/utils";

import {
  buildInventoryDocsForVariants,
  INVENTORY_DOC_FIELDS,
} from "../lib/meilisearch/build-inventory-docs";

/**
 * Incremental single-target sync to the MeiliSearch `inventory` index.
 *
 * Exactly one of { productId, variantId, inventoryItemId } is used to scope
 * the fetch. The workflow computes all inventory documents that roll up from
 * that scope (one product → N variants → N inventory_items) and upserts them
 * in a single addDocuments call.
 *
 * Called from:
 *   • product lifecycle subscriber (cascade from product.created/updated/deleted)
 *   • POS product create/update workflows
 *   • inventory-count approval workflow
 *   • any custom workflow that mutates stock/price/metadata
 *
 * Non-destructive: only touches documents for the scoped target. Orphan
 * cleanup is left to the full resync workflow.
 */

interface Input {
  productId?: string;
  variantId?: string;
  inventoryItemId?: string;
  /** When true and the target resolves to no variants (e.g. product was
   *  deleted), the step will delete the associated Meili docs. */
  deleteWhenMissing?: boolean;
}

const syncInventoryItemToMeiliStep = createStep(
  "sync-inventory-item-to-meili",
  async (input: Input, { container }) => {
    const logger = container.resolve("logger") as {
      info: (m: string) => void;
      warn: (m: string) => void;
      error: (m: string) => void;
    };
    const query = container.resolve("query") as any;
    const pricingService: any = container.resolve(Modules.PRICING);

    if (!input.productId && !input.variantId && !input.inventoryItemId) {
      logger.warn(
        "[syncInventoryItemToMeili] no scope provided (productId/variantId/inventoryItemId) — nothing to do"
      );
      return new StepResponse({ synced: 0, deleted: 0 });
    }

    // Build the filter for the variants query.
    let variantFilter: Record<string, unknown> = {};
    if (input.variantId) {
      variantFilter = { id: input.variantId };
    } else if (input.productId) {
      variantFilter = { product_id: input.productId };
    } else if (input.inventoryItemId) {
      // Resolve the variant that owns this inventory_item via the link
      // table.
      const { data: links } = await query.graph({
        entity: "product_variant_inventory_item",
        fields: ["variant_id"],
        filters: { inventory_item_id: input.inventoryItemId },
      });
      const variantIds = (links ?? [])
        .map((l: any) => l.variant_id)
        .filter(Boolean) as string[];
      if (variantIds.length === 0) {
        // Inventory item is unlinked — delete the doc directly if requested.
        if (input.deleteWhenMissing) {
          const { MeiliSearch } = await import("meilisearch");
          const client = new MeiliSearch({
            host: process.env.MEILISEARCH_HOST!,
            apiKey: process.env.MEILISEARCH_API_KEY!,
          });
          try {
            await client.index("inventory").deleteDocument(input.inventoryItemId);
            logger.info(
              `[syncInventoryItemToMeili] 🗑️  Deleted orphan inventory doc ${input.inventoryItemId}`
            );
            return new StepResponse({ synced: 0, deleted: 1 });
          } catch (e: any) {
            logger.warn(
              `[syncInventoryItemToMeili] delete failed for ${input.inventoryItemId}: ${e.message}`
            );
          }
        }
        return new StepResponse({ synced: 0, deleted: 0 });
      }
      variantFilter = { id: variantIds };
    }

    // Load variants with full graph.
    const { data: variants } = await query.graph({
      entity: "product_variant",
      fields: [...INVENTORY_DOC_FIELDS],
      filters: variantFilter,
    });

    // If the product/variant was deleted and nothing comes back, optionally
    // delete the inventory docs that referenced it.
    if (!variants || variants.length === 0) {
      if (input.deleteWhenMissing && input.productId) {
        // Need to search existing Meili docs by productId and delete them.
        const { MeiliSearch } = await import("meilisearch");
        const client = new MeiliSearch({
          host: process.env.MEILISEARCH_HOST!,
          apiKey: process.env.MEILISEARCH_API_KEY!,
        });
        try {
          const results = await client.index("inventory").search("", {
            filter: `productId = "${input.productId}"`,
            limit: 500,
            attributesToRetrieve: ["id"],
          });
          const ids = (results.hits as Array<{ id: string }>).map((h) => h.id);
          if (ids.length > 0) {
            await client.index("inventory").deleteDocuments(ids);
            logger.info(
              `[syncInventoryItemToMeili] 🗑️  Deleted ${ids.length} inventory docs for removed product ${input.productId}`
            );
            return new StepResponse({ synced: 0, deleted: ids.length });
          }
        } catch (e: any) {
          logger.warn(
            `[syncInventoryItemToMeili] delete-by-product failed for ${input.productId}: ${e.message}`
          );
        }
      }
      return new StepResponse({ synced: 0, deleted: 0 });
    }

    // Load price-list prices for the involved price_set ids.
    const priceSetIds = variants
      .map((v: any) => v.price_set?.id)
      .filter(Boolean) as string[];
    const pricesByPriceSet = new Map<string, Record<string, number>>();
    if (priceSetIds.length > 0) {
      try {
        const plPrices = await pricingService.listPrices(
          { price_set_id: priceSetIds },
          { take: 10000 }
        );
        for (const p of plPrices) {
          if (!p.price_set_id || !p.price_list_id) continue;
          if (p.currency_code && p.currency_code !== "usd") continue;
          if (!pricesByPriceSet.has(p.price_set_id)) {
            pricesByPriceSet.set(p.price_set_id, {});
          }
          pricesByPriceSet.get(p.price_set_id)![p.price_list_id] = p.amount;
        }
      } catch (e: any) {
        logger.warn(
          `[syncInventoryItemToMeili] price list fetch failed: ${e.message}`
        );
      }
    }

    const docs = buildInventoryDocsForVariants(variants, pricesByPriceSet);
    if (docs.length === 0) {
      return new StepResponse({ synced: 0, deleted: 0 });
    }

    const { MeiliSearch } = await import("meilisearch");
    const client = new MeiliSearch({
      host: process.env.MEILISEARCH_HOST!,
      apiKey: process.env.MEILISEARCH_API_KEY!,
    });
    await client
      .index("inventory")
      .addDocuments(docs, { primaryKey: "id" });
    logger.info(
      `[syncInventoryItemToMeili] ✅ Upserted ${docs.length} inventory docs`
    );
    return new StepResponse({ synced: docs.length, deleted: 0 });
  }
);

export const syncInventoryItemToMeiliSearchWorkflow = createWorkflow(
  "sync-inventory-item-to-meilisearch",
  (input: Input) => {
    const result = syncInventoryItemToMeiliStep(input);
    return new WorkflowResponse(result);
  }
);
