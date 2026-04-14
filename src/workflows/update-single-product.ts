import {
  createWorkflow,
  createStep,
  StepResponse,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";

interface UpdateSingleProductInput {
  productId: string;
}

/**
 * INCREMENTAL SYNC: Update Single Product
 *
 * Unlike the full sync workflow, this updates ONLY the specified product.
 * Used by auto-sync middleware for real-time updates.
 *
 * Performance: ~50ms for 1 product vs ~2-5s for full sync
 */

const updateSingleProductStep = createStep(
  "update-single-product-step",
  async ({ productId }: UpdateSingleProductInput, { container }) => {
    const logger = container.resolve("logger");
    const productModule = container.resolve("product");

    try {
      // 1. Fetch the single product with all relations
      const [product] = await productModule.listProducts(
        { id: [productId] },
        {
          relations: [
            "variants",
            "categories",
            "categories.parent_category",
            "categories.parent_category.parent_category",
          ],
        }
      );

      if (!product) {
        logger.warn(
          `[MEILI-INCREMENTAL] Product ${productId} not found, skipping sync`
        );
        return new StepResponse({
          success: false,
          productId: productId,
          title: "",
          variantCount: 0,
        });
      }

      // 2. Initialize MeiliSearch client (dynamic import for ESM compatibility)
      const { MeiliSearch } = await import("meilisearch");
      const client = new MeiliSearch({
        host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
        apiKey: process.env.MEILISEARCH_API_KEY || "masterKey",
      });

      // 3. Transform product for MeiliSearch
      const allCategoryHandles = new Set<string>();

      product.categories?.forEach((c: any) => {
        if (c.handle) allCategoryHandles.add(c.handle);
        if (c.parent_category?.handle)
          allCategoryHandles.add(c.parent_category.handle);
        if (c.parent_category?.parent_category?.handle)
          allCategoryHandles.add(c.parent_category.parent_category.handle);
      });

      const meiliProduct = {
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

      // 4. Update in MeiliSearch (addDocuments with same ID replaces the document)
      const index = client.index("products");
      const result = await index.addDocuments([meiliProduct], {
        primaryKey: "id",
      });

      // 5. Wait for indexing to complete
      await (client as any).tasks.waitForTask(result.taskUid);

      logger.info(
        `[MEILI-INCREMENTAL] ✅ Product ${productId} updated (${product.variants?.length || 0} variants)`
      );

      return new StepResponse({
        success: true,
        productId: product.id,
        title: product.title,
        variantCount: product.variants?.length || 0,
      });
    } catch (error: any) {
      logger.error(
        `[MEILI-INCREMENTAL] ❌ Failed to update product ${productId}:`,
        error.message
      );
      return new StepResponse({
        success: false,
        productId: productId,
        title: "",
        variantCount: 0,
      });
    }
  }
);

export const updateSingleProductWorkflow = createWorkflow(
  "update-single-product",
  (input: UpdateSingleProductInput) => {
    const result = updateSingleProductStep(input);
    return new WorkflowResponse(result);
  }
);
