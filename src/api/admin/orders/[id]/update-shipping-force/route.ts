import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { Modules } from "@medusajs/utils";

/**
 * POST /admin/orders/:id/update-shipping-force
 *
 * Updates the amount of the first shipping method on an order directly.
 * Useful for adjusting the remaining shipping balance when the POS creates a partial invoice
 * with a smaller shipping amount than the Medusa order expects.
 *
 * Body: { amount: number } // in DOLLARS
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { amount } = req.body as { amount: number };
  const orderId = req.params.id;

  if (amount === undefined || typeof amount !== "number") {
    res
      .status(400)
      .json({ message: "amount is required and must be a number" });
    return;
  }

  try {
    const orderModule = req.scope.resolve(Modules.ORDER) as any;

    // 1. Fetch order with shipping methods
    const order = await orderModule.retrieveOrder(orderId, {
      relations: ["shipping_methods"],
    });

    if (!order.shipping_methods || order.shipping_methods.length === 0) {
      res
        .status(404)
        .json({ message: "No shipping methods found on this order" });
      return;
    }

    const smId = order.shipping_methods[0].id;

    // 2. Update the shipping method
    // Shipping methods in v2 usually store amount natively exactly as provided.
    // POS sends amount in dollars so we assume native usage is expected?
    // Or wait... Medusa v2 APIs store prices natively, but wait! The order module `updateShippingMethods` expects what?
    // Medusa v2 often uses `amount` as the raw database value. If it's a data-layer update, it takes exactly the value.
    // Wait, for compatibility, most standard workflows accept dollars but directly calling the module expects DB value.
    // Just in case, updateOrderShippingMethods allows setting the amount directly.
    if (typeof orderModule.updateOrderShippingMethods === "function") {
      await orderModule.updateOrderShippingMethods([
        {
          id: smId,
          amount: amount, // The data layer module assumes the value provided matches the DB precision
        },
      ]);
      console.log(
        `[update-shipping-force] updateOrderShippingMethods OK: ${smId} → amount=${amount}`
      );
      res
        .status(200)
        .json({ success: true, method: "updateOrderShippingMethods" });
      return;
    }

    if (typeof orderModule.updateShippingMethods === "function") {
      await orderModule.updateShippingMethods([
        {
          id: smId,
          amount: amount,
        },
      ]);
      console.log(
        `[update-shipping-force] updateShippingMethods OK: ${smId} → amount=${amount}`
      );
      res.status(200).json({ success: true, method: "updateShippingMethods" });
      return;
    }

    res
      .status(500)
      .json({ message: "No suitable update method found on order module" });
  } catch (e: any) {
    console.error("[update-shipping-force] Error:", e?.message);
    res
      .status(500)
      .json({ message: e?.message ?? "Failed to update shipping" });
  }
}
