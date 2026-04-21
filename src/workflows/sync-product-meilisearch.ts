import {
  createWorkflow,
  WorkflowResponse,
  createStep,
  StepResponse,
} from "@medusajs/framework/workflows-sdk";

import { syncInventoryItemToMeiliSearchWorkflow } from "./sync-inventory-item-meilisearch";

/**
 * Single-product sync to both MeiliSearch indexes:
 *   • `products`   → the product-level doc used by `products-advanced`
 *   • `inventory`  → every inventory_item doc that rolls up from this
 *                    product's variants (cascaded through
 *                    syncInventoryItemToMeiliSearchWorkflow)
 *
 * The cascade means any caller that already trusts this workflow for product
 * sync (lifecycle subscriber, POS create/update workflows, QB item-pipeline
 * poller) now also keeps the inventory index fresh without extra calls.
 */

const syncProductDocStep = createStep(
  "sync-product-doc-to-meili",
  async ({ productId }: { productId: string }, { container }) => {
    const logger = container.resolve("logger") as {
      info: (m: string) => void;
      warn: (m: string) => void;
      error: (m: string) => void;
    };
    const query = container.resolve("query") as any;

    try {
      const { data: products } = await query.graph({
        entity: "product",
        fields: [
          "id",
          "title",
          "description",
          "handle",
          "thumbnail",
          "status",
          "metadata",
          "variants.id",
          "variants.sku",
        ],
        filters: { id: productId },
      });

      const product = products?.[0];
      if (!product) {
        logger.warn(
          `[syncProductDoc] Product not found: ${productId} — skipping doc upsert`
        );
        return new StepResponse({ synced: false });
      }

      const { MeiliSearch } = await import("meilisearch");
      const client = new MeiliSearch({
        host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
        apiKey: process.env.MEILISEARCH_API_KEY || "",
      });
      const index = client.index("products");

      const document = {
        id: product.id,
        title: product.title,
        description: product.description,
        handle: product.handle,
        thumbnail: product.thumbnail,
        variant_sku:
          product.variants?.map((v: any) => v.sku).filter(Boolean) || [],
        metadata: product.metadata || {},
        metadata_material: (product.metadata as any)?.material || null,
        metadata_category: (product.metadata as any)?.category || null,
        status: product.status,
      };

      await index.addDocuments([document], { primaryKey: "id" });
      logger.info(
        `[syncProductDoc] ✅ products index synced: ${product.title} | SKUs: [${document.variant_sku.join(", ")}]`
      );
      return new StepResponse({ synced: true, product: product.title });
    } catch (error: any) {
      logger.error(`[syncProductDoc] ❌ ${error.message}`);
      return new StepResponse({ synced: false, error: error.message });
    }
  }
);

export const syncProductToMeiliSearchWorkflow = createWorkflow(
  "sync-product-to-meilisearch",
  (input: { productId: string }) => {
    const productResult = syncProductDocStep({ productId: input.productId });
    // Cascade: also refresh every inventory doc for this product.
    syncInventoryItemToMeiliSearchWorkflow.runAsStep({
      input: { productId: input.productId },
    });
    return new WorkflowResponse(productResult);
  }
);
