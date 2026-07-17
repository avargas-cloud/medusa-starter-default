import {
  createWorkflow,
  WorkflowResponse,
  createStep,
  StepResponse,
} from "@medusajs/framework/workflows-sdk";
import { Modules } from "@medusajs/utils";

import { CHINA_LOC, USA_LOC } from "../lib/locations";

import {
  buildInventoryDocsForVariants,
  INVENTORY_DOC_FIELDS,
} from "../lib/meilisearch/build-inventory-docs";
import { loadVendorNamesByVariantId } from "../lib/meilisearch/load-vendor-names";
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

    // ─── BULK: Load China + Miami stock levels into RAM once ────────────────
    // totalStock / totalReserved in Meili reflect ONLY Miami (USA_LOC).
    // Orders ship from Miami; China stock surfaces separately as `chinaStock`.
    const chinaStockMap = new Map<string, number>();
    const miamiStockMap = new Map<string, number>();
    const miamiReservedMap = new Map<string, number>();
    try {
      const inventoryService: any = container.resolve(Modules.INVENTORY);
      const chinaLevels = await inventoryService.listInventoryLevels(
        { location_id: CHINA_LOC },
        { take: 100000 }
      );
      for (const level of chinaLevels) {
        if (level.inventory_item_id && level.stocked_quantity != null) {
          const available = (level.stocked_quantity ?? 0) - (level.reserved_quantity ?? 0);
          chinaStockMap.set(level.inventory_item_id, available);
        }
      }
      const miamiLevels = await inventoryService.listInventoryLevels(
        { location_id: USA_LOC },
        { take: 100000 }
      );
      for (const level of miamiLevels) {
        if (level.inventory_item_id) {
          miamiStockMap.set(
            level.inventory_item_id,
            level.stocked_quantity ?? 0
          );
          miamiReservedMap.set(
            level.inventory_item_id,
            level.reserved_quantity ?? 0
          );
        }
      }
      console.log(
        `📦 [sync-inventory] Loaded ${chinaStockMap.size} China + ${miamiStockMap.size} Miami warehouse levels`
      );
    } catch (e: any) {
      console.warn(
        "[sync-inventory] Could not load warehouse levels:",
        e.message
      );
    }

    // ─── BULK: Load on-order balances into RAM once ─────────────────────────
    // USA = open Purchase Orders, China = open Factory Orders. Keyed by
    // inventory_item_id. Independent of chinaStock (current availability).
    const onOrderUsaMap = new Map<string, number>();
    const onOrderChinaMap = new Map<string, number>();
    try {
      const knex = (
        container as unknown as {
          resolve: (k: string) => {
            raw: (
              sql: string
            ) => Promise<{ rows: Array<{ item: string; qty: number }> }>;
          };
        }
      ).resolve("__pg_connection__");
      const usa = await knex.raw(
        `SELECT pol.inventory_item_id AS item,
                SUM(GREATEST(0, pol.qty_ordered - pol.qty_received - pol.qty_cancelled))::int AS qty
           FROM purchase_order_line pol
           JOIN purchase_order po ON po.id = pol.purchase_order_id AND po.deleted_at IS NULL
          WHERE pol.deleted_at IS NULL
            AND pol.inventory_item_id IS NOT NULL
            AND po.status IN ('submitted', 'partially_received')
          GROUP BY pol.inventory_item_id`
      );
      for (const r of usa.rows) onOrderUsaMap.set(r.item, Number(r.qty) || 0);
      const china = await knex.raw(
        `SELECT fol.inventory_item_id AS item,
                SUM(GREATEST(0, fol.qty_ordered - fol.qty_received - fol.qty_cancelled))::int AS qty
           FROM factory_order_line fol
           JOIN factory_order fo ON fo.id = fol.factory_order_id AND fo.deleted_at IS NULL
          WHERE fol.deleted_at IS NULL
            AND fol.inventory_item_id IS NOT NULL
            AND fo.status IN ('submitted', 'partially_received')
          GROUP BY fol.inventory_item_id`
      );
      for (const r of china.rows) onOrderChinaMap.set(r.item, Number(r.qty) || 0);
      console.log(
        `📦 [sync-inventory] Loaded on-order: ${onOrderUsaMap.size} USA(PO) + ${onOrderChinaMap.size} China(FO) items`
      );
    } catch (e: any) {
      console.warn("[sync-inventory] Could not load on-order balances:", e.message);
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

    // Vendor names from the canonical qb_vendor ↔ variant link (all variants).
    const vendorNameByVariantId = await loadVendorNamesByVariantId(container);

    // ─── Transform ALL in RAM ─────────────────────────────────────────────────
    const meiliInventoryItems = buildInventoryDocsForVariants(
      allVariants,
      pricesByPriceSet,
      chinaStockMap,
      miamiStockMap,
      miamiReservedMap,
      vendorNameByVariantId,
      onOrderUsaMap,
      onOrderChinaMap
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
          "onOrderUsa",
          "onOrderChina",
          "is_sourced_via_agent",
        ],
        sortableAttributes: [
          "title",
          "sku",
          "totalStock",
          "totalReserved",
          "chinaStock",
          "onOrderUsa",
          "onOrderChina",
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
