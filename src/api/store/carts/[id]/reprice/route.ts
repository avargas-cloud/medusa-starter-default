import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { repriceCart } from "./reprice-cart";

/**
 * POST /store/carts/:id/reprice
 *
 * Reprices ALL items in a cart using Medusa's native `refreshCartItemsWorkflow`.
 *
 * CALLED IN TWO SCENARIOS:
 *   1. LOGIN  (WITH auth token):  actor_id resolved → additional_data.force_retail=false
 *                                  → hook injects customer_group_id → wholesale prices
 *   2. LOGOUT (NO auth token):    no actor_id → additional_data.force_retail=true
 *                                  → hook skips customer lookup → retail base prices
 *
 * WHY additional_data.force_retail:
 *   The hook reads customer_id from the CART in the DB (not the HTTP auth token).
 *   If the cart still has customer_id linked when logout reprice runs, the hook
 *   would see it and apply wholesale. Passing force_retail=true bypasses this.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  try {
    const cartId = req.params.id as string;
    const actorId = (req as any).auth_context?.actor_id;
    const isAuthenticated = !!actorId;

    console.log(
      `[REPRICE] 🔄 Cart ${cartId} | auth=${isAuthenticated} | force_retail=${!isAuthenticated}`
    );

    const cart = await repriceCart(req.scope, cartId, actorId);

    console.log(`[REPRICE] ✅ Done.`);
    return res.json({
      success: true,
      updatesApplied: (cart as any)?.items?.length ?? 0,
    });
  } catch (error: any) {
    console.error("[REPRICE] ❌ Error:", error.message, error.stack);
    return res.status(500).json({
      error: "Failed to reprice cart",
      message: error.message,
    });
  }
};
