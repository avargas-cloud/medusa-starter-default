import {
  createWorkflow,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";

export const syncProductsToMeiliStep = createStep(
  "sync-products-to-meili-step",
  async (_, { container }) => {
    const { MeiliSearch } = await import("meilisearch");
    const query = container.resolve("query") as any;

    const client = new MeiliSearch({
      host: process.env.MEILISEARCH_HOST!,
      apiKey: process.env.MEILISEARCH_API_KEY!,
    });
    const index = client.index("products");

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

    // 3. Update settings
    await index.updateSettings({
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
      sortableAttributes: ["title", "status", "id", "updated_at", "created_at"],
      searchableAttributes: [
        "title",
        "variant_sku",
        "handle",
        "description",
        "metadata_material",
      ],
    });

    // 4. Atomic clear — wait for completion before uploading (prevents race condition)
    console.log(
      "🗑️  [sync-products] Clearing index (waiting for completion)..."
    );
    const deleteTask = await index.deleteAllDocuments();
    await (client as any).tasks.waitForTask(deleteTask.taskUid);
    console.log("✅ [sync-products] Index cleared");

    // 5. Upload ALL chunks in parallel
    const CHUNK = 1000;
    const chunks: (typeof meiliProducts)[] = [];
    for (let i = 0; i < meiliProducts.length; i += CHUNK) {
      chunks.push(meiliProducts.slice(i, i + CHUNK));
    }

    console.log(
      `🚀 [sync-products] Uploading ${chunks.length} chunks in parallel...`
    );
    const t1 = Date.now();
    const uploadTasks = await Promise.all(
      chunks.map((chunk) => index.addDocuments(chunk, { primaryKey: "id" }))
    );
    await (client as any).tasks.waitForTasks(uploadTasks.map((t) => t.taskUid));
    console.log(
      `✅ [sync-products] Synced ${meiliProducts.length} products in ${Date.now() - t1}ms`
    );

    return new StepResponse({
      success: true,
      synced: meiliProducts.length,
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
