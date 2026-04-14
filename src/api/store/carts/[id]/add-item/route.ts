import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { addToCartWorkflow } from "@medusajs/core-flows";

/**
 * POST /store/carts/:id/add-item
 *
 * Adds an item to the cart using Medusa's native `addToCartWorkflow`.
 *
 * Wholesale pricing is applied automatically by Medusa's pricing engine
 * because the frontend links the customer to the cart (via POST /carts/:id/customer)
 * BEFORE calling this endpoint. When the cart has a `customer_id`, Medusa resolves
 * the customer's group and selects the matching Price List rule natively.
 *
 * No manual `unit_price` override is needed. That approach caused `is_custom_price: true`
 * which broke the Medusa Admin order list total display.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  try {
    const cartId = req.params.id as string;
    const body = req.body as {
      variant_id: string;
      quantity: number;
      metadata?: Record<string, any>;
    };

    if (!body.variant_id || !body.quantity) {
      return res
        .status(400)
        .json({ message: "variant_id and quantity are required" });
    }

    console.log(
      `[ADD-ITEM] 🛒 Adding variant ${body.variant_id} x${body.quantity} to cart ${cartId}`
    );

    const { result } = await addToCartWorkflow(req.scope).run({
      input: {
        cart_id: cartId,
        items: [
          {
            variant_id: body.variant_id,
            quantity: body.quantity,
            metadata: body.metadata,
          },
        ],
      },
    });

    return res.json({ cart: result });
  } catch (error: any) {
    console.error("[ADD-ITEM] ❌ Error:", error.message);
    return res.status(500).json({
      error: "Failed to add item to cart",
      message: error.message,
    });
  }
};
