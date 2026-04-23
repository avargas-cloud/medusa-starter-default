import {
  createWorkflow,
  WorkflowResponse,
  createStep,
  StepResponse,
} from "@medusajs/framework/workflows-sdk";
import { Modules } from "@medusajs/utils";

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
      fields: [
        "id",
        "sku",
        "thumbnail",
        "images.id",
        "images.url",
        "metadata",
        "created_at",
        "updated_at",
        "price_set.id",
        "product.id",
        "product.title",
        "product.handle",
        "product.thumbnail",
        "product.status",
        "product.metadata",
        "product.categories.id",
        "product.categories.handle",
        "product.categories.parent_category.handle",
        "product.categories.parent_category.parent_category.handle",
        "prices.amount",
        "prices.currency_code",
        "prices.price_list_id",
        "inventory_items.inventory.id",
        "inventory_items.inventory.sku",
        "inventory_items.inventory.title",
        "inventory_items.inventory.created_at",
        "inventory_items.inventory.updated_at",
        "inventory_items.inventory.stocked_quantity",
        "inventory_items.inventory.reserved_quantity",
        "options.value",
        "options.option.title",
      ],
      pagination: { skip: 0, take: 50000 },
    });
    console.log(
      `✅ [sync-inventory] Loaded ${allVariants.length} variants in ${Date.now() - t0}ms`
    );

    // ─── Transform ALL in RAM ─────────────────────────────────────────────────
    const meiliInventoryItems = allVariants.flatMap((variant: any) => {
      const product = variant.product;
      const usdPrices = (variant.prices || []).filter(
        (p: any) => p.currency_code === "usd"
      );
      const retailPrice =
        usdPrices.length > 0
          ? usdPrices.reduce((max: any, p: any) =>
              p.amount > max.amount ? p : max
            )
          : null;

      const priceSetId = variant.price_set?.id;
      const pricesByList = priceSetId
        ? (pricesByPriceSet.get(priceSetId) ?? {})
        : {};

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

      // variant.thumbnail is set explicitly via backfill or the new variant
      // thumbnail mechanism. Falls back to the product's designated thumbnail.
      const resolvedThumbnail = variant.thumbnail ?? product?.thumbnail ?? null;

      // No inventory items → synthetic document (unmanaged/services)
      if (!variant.inventory_items || variant.inventory_items.length === 0) {
        if (!variant.sku) return [];
        return [
          {
            id: variant.id,
            sku: variant.sku,
            title: product?.title || "Untitled",
            thumbnail: resolvedThumbnail,
            totalStock: null,
            totalReserved: 0,
            price: retailPrice?.amount || 0,
            currencyCode: retailPrice?.currency_code?.toUpperCase() || "USD",
            pricesByList,
            variantId: variant.id,
            productId: product?.id || null,
            handle: product?.handle || null,
            salesDescription:
              (variant?.metadata as any)?.sales_description || null,
            cost: (variant?.metadata as any)?.qb_purchase_cost || null,
            vendorName: (variant?.metadata as any)?.qb_vendor_name || null,
            options: mappedOptions,
            category_handles: Array.from(allCategoryHandles),
            status: product?.status || "draft",
            created_at: new Date(variant.created_at).getTime(),
            updated_at: new Date(variant.updated_at).getTime(),
          },
        ];
      }

      return (variant.inventory_items || []).map((invItem: any) => {
        const inventory = invItem.inventory;
        return {
          id: inventory.id,
          sku: inventory.sku || variant.sku || "",
          title: inventory.title || product?.title || "Untitled",
          thumbnail: resolvedThumbnail,
          totalStock: inventory.stocked_quantity || 0,
          totalReserved: inventory.reserved_quantity || 0,
          price: retailPrice?.amount || 0,
          currencyCode: retailPrice?.currency_code?.toUpperCase() || "USD",
          pricesByList,
          variantId: variant.id,
          productId: product?.id || null,
          handle: product?.handle || null,
          salesDescription:
            (variant?.metadata as any)?.sales_description || null,
          cost: (variant?.metadata as any)?.qb_purchase_cost || null,
          vendorName: (variant?.metadata as any)?.qb_vendor_name || null,
          options: mappedOptions,
          category_handles: Array.from(allCategoryHandles),
          status: product?.status || "draft",
          created_at: new Date(
            inventory.created_at || variant.created_at
          ).getTime(),
          updated_at: new Date(
            inventory.updated_at || variant.updated_at
          ).getTime(),
        };
      });
    });

    const validItems = meiliInventoryItems.filter(
      (item: any) => item.variantId && item.productId
    );
    console.log(
      `🔄 [sync-inventory] Transformed ${validItems.length} valid items in RAM`
    );

    // Safe upsert + orphan cleanup (replaces destructive delete-all).
    const result = await safeSyncIndex({
      client,
      indexName: "inventory",
      primaryKey: "id",
      docs: validItems,
      settings: {
        filterableAttributes: ["category_handles", "status", "id", "sku"],
        sortableAttributes: [
          "title",
          "sku",
          "totalStock",
          "price",
          "totalReserved",
          "updated_at",
          "created_at",
        ],
        searchableAttributes: ["title", "sku", "salesDescription"],
      },
      logger: {
        info: (m) => console.log(m),
        warn: (m) => console.warn(m),
        error: (m) => console.error(m),
      },
    });

    const withCategory = validItems.filter(
      (i: any) => i.category_handles.length > 0
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
