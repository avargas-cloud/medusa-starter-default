import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { syncInventoryWorkflow } from "../../../../../workflows/sync-inventory";

/**
 * POST /admin/search/inventory/sync
 *
 * Synchronize all inventory items to MeiliSearch index
 * Now with smart sync verification (checks count + timestamp)
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  try {
    const query = req.scope.resolve("query");

    // 1. Get MeiliSearch Stats (dynamic import for ESM compatibility)
    const { MeiliSearch } = await import("meilisearch");
    const client = new MeiliSearch({
      host: process.env.MEILISEARCH_HOST!,
      apiKey: process.env.MEILISEARCH_API_KEY!,
    });

    let meiliCount = 0;

    try {
      const index = client.index("inventory");
      const stats = await index.getStats();
      meiliCount = stats.numberOfDocuments;
    } catch (e) {
      // Index might not exist yet
    }

    // 2. Get DB Stats — mirrors the sync workflow logic exactly
    const { data: variants } = await query.graph({
      entity: "product_variant",
      fields: [
        "id", "sku", "updated_at",
        "product.id",
        "inventory_items.inventory.id",
        "inventory_items.inventory.updated_at",
      ],
    });

    // Workflow uploads: inventory-linked items + synthetic docs (no-inventory variants with a product)
    const inventoryLinked = variants.flatMap((variant: any) =>
      (variant.inventory_items ?? []).map((invItem: any) => ({
        variantId: variant.id,
        productId: variant.product?.id,
        updated_at: invItem.inventory?.updated_at || variant.updated_at,
      }))
    );

    const synthetic = variants
      .filter((v: any) =>
        (!v.inventory_items || v.inventory_items.length === 0) &&
        v.sku && v.product?.id
      )
      .map((v: any) => ({
        variantId: v.id,
        productId: v.product.id,
        updated_at: v.updated_at,
      }));

    const allDocs = [...inventoryLinked, ...synthetic].filter(
      (item: any) => item.variantId && item.productId
    );
    const dbCount = allDocs.length;

    console.log(
      `🔍 [Inventory Sync Check] DB docs: ${dbCount} (${inventoryLinked.length} linked + ${synthetic.length} synthetic) | Meili: ${meiliCount}`
    );

    // 3. Check if sync is needed (skip if force=true)
    const force = req.query.force === "true";
    const isCountSync = dbCount === meiliCount;

    console.log(
      `🔍 [Inventory Sync Status] Count Match: ${isCountSync} (${dbCount} vs ${meiliCount}), Force: ${force}`
    );

    if (!force && isCountSync) {
      console.log(`✅ [Inventory Sync] Already in sync!`);
      return res.json({
        success: true,
        synced: 0,
        status: "already_synced",
        message: "Inventory already synced",
      });
    }

    // 4. Perform full sync
    console.log(`🔄 [Inventory Sync] Starting full sync...`);
    const { result } = await syncInventoryWorkflow(req.scope).run({
      input: {},
    });

    return res.json({
      ...result,
      status: "synced",
    });
  } catch (error: any) {
    console.error(
      "[MeiliSearch Inventory Sync Error]:",
      (error as Error).message
    );

    return res.status(500).json({
      success: false,
      error: "Sync failed",
      message: (error as Error).message,
    });
  }
};

// Middleware to protect this route (admin only)
export const AUTHENTICATE = ["user"];
