import {
  createWorkflow,
  createStep,
  StepResponse,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";

interface UpdateInventoryIncrementalInput {
  variantId?: string;
  productId?: string;
}

/**
 * INCREMENTAL SYNC: Update Inventory for Product/Variant
 *
 * Updates inventory items affected by a product or variant change.
 * Unlike full sync, only updates relevant inventory entries.
 */

const updateInventoryIncrementalStep = createStep(
  "update-inventory-incremental-step",
  async (
    { variantId, productId }: UpdateInventoryIncrementalInput,
    { container }
  ) => {
    const logger = container.resolve("logger");
    const query = container.resolve("query");
    const pricingService = container.resolve("pricing") as any;

    try {
      // Dynamic import for ESM compatibility
      const { MeiliSearch } = await import("meilisearch");

      // 1. Determine which variants to sync
      let variantIds: string[] = [];

      if (variantId) {
        variantIds = [variantId];
      } else if (productId) {
        // Get all variants for this product
        const { data: variants } = await query.graph({
          entity: "product_variant",
          fields: ["id"],
          filters: { product_id: productId },
        });
        variantIds = variants?.map((v: any) => v.id) || [];
      }

      if (variantIds.length === 0) {
        logger.warn(`[MEILI-INVENTORY-INCREMENTAL] No variants to sync`);
        return new StepResponse({ success: false, itemsUpdated: 0 });
      }

      // 1b. Load price_list prices indexed by price_set_id (mirrors
      // sync-inventory.ts logic) so the Meili doc carries `pricesByList`
      // — otherwise wholesale pricing never makes it to the inventory index.
      const pricesByPriceSet = new Map<string, Record<string, number>>();
      try {
        const allPriceLists = await pricingService.listPriceLists();
        const priceListIds = allPriceLists.map((pl: any) => pl.id);
        if (priceListIds.length > 0) {
          const priceListPrices = await pricingService.listPrices(
            { price_list_id: priceListIds },
            { take: 100000 }
          );
          for (const p of priceListPrices) {
            if (
              !p.price_set_id ||
              !p.price_list_id ||
              p.currency_code !== "usd"
            )
              continue;
            if (!pricesByPriceSet.has(p.price_set_id)) {
              pricesByPriceSet.set(p.price_set_id, {});
            }
            pricesByPriceSet.get(p.price_set_id)![p.price_list_id] = p.amount;
          }
        }
      } catch (e: any) {
        logger.warn(
          `[MEILI-INVENTORY-INCREMENTAL] Could not load price list prices: ${e.message}`
        );
      }

      // 2. Fetch variants with all data (MUST MATCH sync-inventory.ts fields!)
      const { data: variants } = await query.graph({
        entity: "product_variant",
        fields: [
          "id",
          "sku",
          "metadata",
          "price_set.id",
          "created_at",
          "updated_at",
          "product.id",
          "product.title",
          "product.handle",
          "product.thumbnail",
          "product.status",
          "product.categories.id",
          "product.categories.handle",
          "product.categories.parent_category.handle",
          "product.categories.parent_category.parent_category.handle",
          "prices.amount",
          "prices.currency_code",
          "inventory_items.inventory.id",
          "inventory_items.inventory.sku",
          "inventory_items.inventory.title",
          "inventory_items.inventory.created_at",
          "inventory_items.inventory.updated_at",
          "inventory_items.inventory.stocked_quantity", // ✅ DIRECT field (not location_levels)
          "inventory_items.inventory.reserved_quantity", // ✅ DIRECT field
          "options.value",
          "options.option.title",
        ],
        filters: { id: variantIds },
      });

      // 3. Transform to inventory items (MUST MATCH sync-inventory.ts logic!)
      const inventoryItems = variants.flatMap((variant: any) => {
        const product = variant.product;
        const priceObj = variant.prices?.[0];
        const priceSetId = variant.price_set?.id;
        const pricesByList = priceSetId
          ? (pricesByPriceSet.get(priceSetId) ?? {})
          : {};

        // ✅ Flatten all category handles (including parents) - SAME AS FULL SYNC
        const allCategoryHandles = new Set<string>();
        product?.categories?.forEach((c: any) => {
          if (c.handle) allCategoryHandles.add(c.handle);
          if (c.parent_category?.handle)
            allCategoryHandles.add(c.parent_category.handle);
          if (c.parent_category?.parent_category?.handle)
            allCategoryHandles.add(c.parent_category.parent_category.handle);
        });

        const mappedOptions = (variant.options || []).map((opt: any) => ({
          title: opt.option?.title || "Option",
          value: opt.value || "",
        }));

        return (
          variant.inventory_items
            ?.map((invItem: any) => {
              const inventory = invItem.inventory;
              if (!inventory || !variant.product?.id) return null;

              return {
                id: inventory.id,
                sku: inventory.sku || variant.sku || "",
                title: inventory.title || product?.title || "Untitled",
                thumbnail: product?.thumbnail || null,
                totalStock: inventory.stocked_quantity || 0, // ✅ FIXED: Direct field
                totalReserved: inventory.reserved_quantity || 0, // ✅ FIXED: Direct field
                price: priceObj?.amount || 0, // v2: already in dollars
                currencyCode: priceObj?.currency_code?.toUpperCase() || "USD",
                pricesByList,
                variantId: variant.id,
                productId: product.id,
                handle: product?.handle || null,
                salesDescription:
                  (variant?.metadata as any)?.sales_description || null,
                cost: (variant?.metadata as any)?.qb_purchase_cost || null,
                vendorName: (variant?.metadata as any)?.qb_vendor_name || null,
                options: mappedOptions,
                category_handles: Array.from(allCategoryHandles), // ✅ FIXED: Include parents
                status: product.status || "draft",
                created_at: new Date(
                  inventory.created_at || variant.created_at
                ).getTime(),
                updated_at: new Date(
                  inventory.updated_at || variant.updated_at
                ).getTime(),
              };
            })
            .filter(Boolean) || []
        );
      });

      if (inventoryItems.length === 0) {
        logger.warn(
          `[MEILI-INVENTORY-INCREMENTAL] No inventory items found for variants`
        );
        return new StepResponse({ success: false, itemsUpdated: 0 });
      }

      // 4. Update in MeiliSearch
      const client = new MeiliSearch({
        host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
        apiKey: process.env.MEILISEARCH_API_KEY || "masterKey",
      });

      const index = client.index("inventory");
      const result = await index.addDocuments(inventoryItems, {
        primaryKey: "id",
      });

      // 5. Wait for indexing to complete
      await (client as any).tasks.waitForTask(result.taskUid);

      logger.info(
        `[MEILI-INVENTORY-INCREMENTAL] ✅ Updated ${inventoryItems.length} items`
      );

      return new StepResponse({
        success: true,
        itemsUpdated: inventoryItems.length,
      });
    } catch (error: any) {
      logger.error(`[MEILI-INVENTORY-INCREMENTAL] ❌ Failed:`, error.message);
      return new StepResponse({ success: false, itemsUpdated: 0 });
    }
  }
);

export const updateInventoryIncrementalWorkflow = createWorkflow(
  "update-inventory-incremental",
  (input: UpdateInventoryIncrementalInput) => {
    const result = updateInventoryIncrementalStep(input);
    return new WorkflowResponse(result);
  }
);
