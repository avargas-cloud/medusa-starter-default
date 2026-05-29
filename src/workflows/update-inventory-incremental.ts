import {
  createWorkflow,
  createStep,
  StepResponse,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import { Modules } from "@medusajs/utils";

import { CHINA_LOC, USA_LOC } from "../lib/locations";
import {
  buildInventoryDocsForVariants,
  INVENTORY_DOC_FIELDS,
} from "../lib/meilisearch/build-inventory-docs";
import { loadVendorNamesByVariantId } from "../lib/meilisearch/load-vendor-names";

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
        fields: [...INVENTORY_DOC_FIELDS],
        filters: { id: variantIds },
      });

      const inventoryItemIds = new Set<string>();
      for (const variant of variants as any[]) {
        for (const invItem of variant.inventory_items ?? []) {
          if (invItem?.inventory?.id) inventoryItemIds.add(invItem.inventory.id);
        }
      }

      const miamiStockMap = new Map<string, number>();
      const miamiReservedMap = new Map<string, number>();
      const chinaStockMap = new Map<string, number>();
      if (inventoryItemIds.size > 0) {
        const inventoryService: any = container.resolve(Modules.INVENTORY);
        const ids = Array.from(inventoryItemIds);

        const miamiLevels = await inventoryService.listInventoryLevels(
          { location_id: USA_LOC, inventory_item_id: ids },
          { take: 100000 }
        );
        for (const level of miamiLevels) {
          miamiStockMap.set(level.inventory_item_id, level.stocked_quantity ?? 0);
          miamiReservedMap.set(
            level.inventory_item_id,
            level.reserved_quantity ?? 0
          );
        }

        const chinaLevels = await inventoryService.listInventoryLevels(
          { location_id: CHINA_LOC, inventory_item_id: ids },
          { take: 100000 }
        );
        for (const level of chinaLevels) {
          const available = (level.stocked_quantity ?? 0) - (level.reserved_quantity ?? 0);
          chinaStockMap.set(level.inventory_item_id, available);
        }
      }

      // 3. Transform to inventory docs using the shared full-sync logic.
      // This keeps `totalStock` Miami-only and exposes China separately.
      const vendorNameByVariantId = await loadVendorNamesByVariantId(
        container,
        variants.map((v: any) => v.id)
      );

      const inventoryItems = buildInventoryDocsForVariants(
        variants,
        pricesByPriceSet,
        chinaStockMap,
        miamiStockMap,
        miamiReservedMap,
        vendorNameByVariantId
      ).filter((item) => item.variantId && item.productId);

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
