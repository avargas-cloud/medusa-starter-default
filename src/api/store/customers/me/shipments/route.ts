import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { listCustomerShipments } from "../../../../../lib/storefront/customer-documents";

/**
 * GET /store/customers/me/shipments
 *
 * Query params: order_id (optional). Custom route, no Medusa list-param
 * validator registered for /store/customers/me/* — unknown keys are ignored.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const customerId = (req as any).auth_context?.actor_id;
  if (!customerId) {
    res.status(401).json({ message: "Unauthorized. No customer ID found." });
    return;
  }

  try {
    const { order_id } = req.query as Record<string, string>;

    const { shipments } = await listCustomerShipments(req.scope, customerId, {
      orderId: order_id || undefined,
    });

    res.json({ shipments });
  } catch (err) {
    const logger = req.scope.resolve("logger") as any;
    logger.error(
      `[store/customers/me/shipments] failed to list shipments: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    res.status(500).json({ message: "Failed to load shipments" });
  }
}
