import {
  createWorkflow,
  WorkflowResponse,
  createStep,
  StepResponse,
} from "@medusajs/framework/workflows-sdk";

import { safeSyncIndex } from "../lib/meilisearch/safe-sync";

export const syncProductsToMeiliStep = createStep(
  "sync-products-to-meili-step",
  async (_, { container }) => {
    const { MeiliSearch } = await import("meilisearch");
    const query = container.resolve("query") as any;

    const client = new MeiliSearch({
      host: process.env.MEILISEARCH_HOST!,
      apiKey: process.env.MEILISEARCH_API_KEY!,
    });

    // 1. Load ALL products into RAM in a single query (no pagination loop)
    const t0 = Date.now();
    console.log("📥 [sync-products] Loading all products into RAM...");
    const { data: allProducts } = await query.graph({
      entity: "product",
      fields: [
        "id",
        "title",
        "handle",
        "description",
        "thumbnail",
        "status",
        "material",
        "updated_at",
        "created_at",
        "categories.handle",
        "categories.parent_category.handle",
        "categories.parent_category.parent_category.handle",
        "variants.*",
        "variants.options.*",
        "variants.options.option.*",
      ],
      pagination: { skip: 0, take: 50000 },
    });
    console.log(
      `✅ [sync-products] Loaded ${allProducts.length} products in ${Date.now() - t0}ms`
    );

    // 2. Transform ALL in RAM
    const meiliProducts = allProducts.map((product: any) => {
      const allCategoryHandles = new Set<string>();
      product.categories?.forEach((c: any) => {
        if (c.handle) allCategoryHandles.add(c.handle);
        if (c.parent_category?.handle)
          allCategoryHandles.add(c.parent_category.handle);
        if (c.parent_category?.parent_category?.handle)
          allCategoryHandles.add(c.parent_category.parent_category.handle);
      });
      return {
        id: product.id,
        title: product.title,
        handle: product.handle,
        description: product.description || "",
        thumbnail: product.thumbnail || null,
        status: product.status,
        metadata_material: product.material || null,
        category_handles: Array.from(allCategoryHandles),
        variant_sku:
          product.variants?.map((v: any) => v.sku).filter(Boolean) || [],
        created_at: new Date(product.created_at).getTime(),
        updated_at: new Date(product.updated_at).getTime(),
      };
    });
    console.log(
      `🔄 [sync-products] Transformed ${meiliProducts.length} documents in RAM`
    );

    // 3. Safe upsert + orphan cleanup (replaces destructive delete-all).
    const result = await safeSyncIndex({
      client,
      indexName: "products",
      primaryKey: "id",
      docs: meiliProducts,
      settings: {
        displayedAttributes: [
          "id",
          "title",
          "handle",
          "thumbnail",
          "status",
          "variant_sku",
          "updated_at",
          "created_at",
          "metadata",
          "description",
          "category_handles",
        ],
        filterableAttributes: ["category_handles", "status", "id", "variant_sku"],
        sortableAttributes: [
          "title",
          "status",
          "id",
          "updated_at",
          "created_at",
        ],
        searchableAttributes: [
          "title",
          "variant_sku",
          "handle",
          "description",
          "metadata_material",
        ],
      },
      logger: {
        info: (m) => console.log(m),
        warn: (m) => console.warn(m),
        error: (m) => console.error(m),
      },
    });

    return new StepResponse({
      success: true,
      synced: result.upserted,
      orphansDeleted: result.orphansDeleted,
      totalInIndex: result.totalInIndex,
      durationMs: result.durationMs,
    });
  }
);

export const syncProductsWorkflow = createWorkflow(
  "sync-products-workflow",
  () => {
    const result = syncProductsToMeiliStep();
    return new WorkflowResponse(result);
  }
);
