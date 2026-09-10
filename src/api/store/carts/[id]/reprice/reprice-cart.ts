import { refreshCartItemsWorkflow } from "@medusajs/core-flows";
import type { MedusaContainer } from "@medusajs/framework/types";

/**
 * Reprices ALL items in a cart using Medusa's native `refreshCartItemsWorkflow`.
 * Shared by `POST /store/carts/:id/reprice` and `POST /store/fast-checkout`
 * (the latter calls this right before reading the cart total to charge, so the
 * customer is always billed the price that matches their CURRENT tier).
 *
 * WHY additional_data.force_retail:
 *   The hook reads customer_id from the CART in the DB (not the HTTP auth token).
 *   If the cart still has customer_id linked when a logout reprice runs, the hook
 *   would see it and apply wholesale. Passing force_retail=true bypasses this.
 *   actorId absent (guest / not authenticated) → force_retail=true.
 */
export async function repriceCart(
  container: MedusaContainer,
  cartId: string,
  actorId?: string | null
) {
  const force_retail = !actorId;
  const { result: cart } = await refreshCartItemsWorkflow(container).run({
    input: {
      cart_id: cartId,
      force_refresh: true,
      additional_data: { force_retail },
    },
  });
  return cart;
}
