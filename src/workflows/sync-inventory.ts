import {
  createWorkflow,
  WorkflowResponse,
  createStep,
  StepResponse,
} from "@medusajs/framework/workflows-sdk";
import { Modules } from "@medusajs/utils";

const CHINA_LOCATION_ID = "sloc_01KQ14C1CFX30EDD722BF87HDM";

import {
  buildInventoryDocsForVariants,
  INVENTORY_DOC_FIELDS,
} from "../lib/meilisearch/build-inventory-docs";
import { safeSyncIndex } from "../lib/meilisearch/safe-sync";

export const syncInventoryToMeiliStep = createStep(
  "sync-to-meili-step",
  async (_, { container }) => {
    const { MeiliSearch } = await import("meilisearch");
    const query = container.resolve("query") as any;
    const pricingService: any = container.resolve(Modules.PRICING);

    const client = new MeiliSearch({
      host: process.env.MEILISEARCH_HOST!,
      apiKey: process.env.MEILISEARCH_API_KEY!,
    });

    // ─── BULK: Load China warehouse stock levels into RAM once ───────────────
    const chinaStockMap = new Map<string, number>();
    try {
      const inventoryService: any = container.resolve(Modules.INVENTORY);
      const chinaLevels = await inventoryService.listInventoryLevels(
        { location_id: CHINA_LOCATION_ID },
        { take: 100000 }
      );
      for (const level of chinaLevels) {
        if (level.inventory_item_id && level.stocked_quantity != null) {
          chinaStockMap.set(level.inventory_item_id, level.stocked_quantity);
        }
      }
      console.log(
        `📦 [sync-inventory] Loaded ${chinaStockMap.size} China warehouse levels`
      );
    } catch (e: any) {
      console.warn(
        "[sync-inventory] Could not load China warehouse levels:",
        e.message
      );
    }

    // ─── BULK: Load all price list prices into RAM once ─────────────────────
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
          if (!p.price_set_id || !p.price_list_id || p.currency_code !== "usd")
            continue;
          if (!pricesByPriceSet.has(p.price_set_id)) {
            pricesByPriceSet.set(p.price_set_id, {});
          }
          pricesByPriceSet.get(p.price_set_id)![p.price_list_id] = p.amount;
        }
      }
    } catch (e: any) {
      console.warn(
        "[sync-inventory] Could not load price list prices:",
        e.message
      );
    }

    // ─── Load ALL variants into RAM in a single query ────────────────────────
    const t0 = Date.now();
    console.log("📥 [sync-inventory] Loading all variants into RAM...");
    const { data: allVariants } = await query.graph({
      entity: "product_variant",
      fields: [...INVENTORY_DOC_FIELDS],
      pagination: { skip: 0, take: 50000 },
    });
    console.log(
      `✅ [sync-inventory] Loaded ${allVariants.length} variants in ${Date.now() - t0}ms`
    );

    // ─── Transform ALL in RAM ─────────────────────────────────────────────────
    const meiliInventoryItems = buildInventoryDocsForVariants(
      allVariants,
      pricesByPriceSet,
      chinaStockMap
    );

    const validItems = meiliInventoryItems.filter(
      (item) => item.variantId && item.productId
    );
    console.log(
      `🔄 [sync-inventory] Transformed ${validItems.length} valid items in RAM`
    );

    // Safe upsert + orphan cleanup (replaces destructive delete-all).
    const result = await safeSyncIndex({
      client,
      indexName: "inventory",
      primaryKey: "id",
      docs: validItems as unknown as Record<string, unknown>[],
      settings: {
        filterableAttributes: [
          "category_handles",
          "status",
          "id",
          "sku",
          "vendorName",
          "productId",
          "variantId",
        ],
        sortableAttributes: [
          "title",
          "sku",
          "totalStock",
          "totalReserved",
          "chinaStock",
          "price",
          "updated_at",
          "created_at",
        ],
        searchableAttributes: [
          "sku",
          "sku_plain",
          "title",
          "salesDescription",
          "purchaseDescription",
          "mpn",
          "vendorName",
        ],
      },
      logger: {
        info: (m) => console.log(m),
        warn: (m) => console.warn(m),
        error: (m) => console.error(m),
      },
    });

    const withCategory = validItems.filter(
      (i) => i.category_handles.length > 0
    );

    return new StepResponse({
      success: true,
      synced: result.upserted,
      itemsWithCategory: withCategory.length,
      orphansDeleted: result.orphansDeleted,
      totalInIndex: result.totalInIndex,
      durationMs: result.durationMs,
    });
  }
);

export const syncInventoryWorkflow = createWorkflow(
  "sync-inventory-workflow",
  () => {
    const result = syncInventoryToMeiliStep();
    return new WorkflowResponse(result);
  }
);
