import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { updateSingleProductWorkflow } from "../../../../../workflows/update-single-product";

/**
 * INCREMENTAL SYNC ENDPOINT: Update Single Product
 *
 * Used by auto-sync middleware to update only the changed product.
 * Much faster than full sync (50ms vs 2-5s).
 */

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const { productId } = req.body as { productId: string };

  if (!productId) {
    return res.status(400).json({
      error: "productId is required",
    });
  }

  try {
    const { result } = (await updateSingleProductWorkflow(req.scope).run({
      input: { productId },
    })) as {
      result: {
        success: boolean;
        productId?: string;
        title?: string;
        variantCount?: number;
        reason?: string;
      };
    };

    return res.json({
      success: result.success,
      productId: result.productId,
      title: result.title,
      variantCount: result.variantCount,
    });
  } catch (error: any) {
    console.error("[MEILI-UPDATE-PRODUCT] Error:", error);
    return res.status(500).json({
      error: "Failed to update product in MeiliSearch",
      details: (error as Error).message,
    });
  }
};

// Middleware to protect this route (admin only)
export const config = {
  auth: true,
};
