import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/utils";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);
  const orderId = req.query.id as string;

  // Test with the display_id they passed, e.g. ?id=1119
  const {
    data: [order],
  } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "subtotal",
      "discount_total",
      "tax_total",
      "total",
      "items.*",
      "items.subtotal",
      "items.discount_total",
      "items.total",
    ],
    filters: { display_id: orderId },
  });

  res.json({ order });
}
