import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { syncInventoryItemToMeiliSearchWorkflow } from "../../../../../workflows/sync-inventory-item-meilisearch";

/**
 * INCREMENTAL SYNC ENDPOINT: Update Inventory
 *
 * Used by auto-sync middleware to update inventory for specific variant/product.
 */

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const { variantId, productId } = req.body as {
    variantId?: string;
    productId?: string;
  };

  if (!variantId && !productId) {
    return res.status(400).json({
      error: "variantId or productId is required",
    });
  }

  try {
    await syncInventoryItemToMeiliSearchWorkflow(req.scope).run({
      input: { variantId, productId },
    });

    return res.json({ success: true });
  } catch (error: any) {
    console.error("[MEILI-UPDATE-INVENTORY] Error:", error);
    return res.status(500).json({
      error: "Failed to update inventory in MeiliSearch",
      details: (error as Error).message,
    });
  }
};

// Middleware to protect this route (admin only)
export const config = {
  auth: true,
};
