import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

/**
 * GET /admin/order-taxable-items/:orderId
 * Returns { items: [{ id, taxable }] } for all line items in an order.
 *
 * Why this exists: order_line_item.taxable is a custom column added via raw
 * SQL migration. Medusa's MikroORM entity model doesn't know about it, so
 * the standard /admin/orders/:id endpoint omits it from the line-item payload.
 * This companion endpoint reads the column directly so the POS can hydrate
 * `POSLineItem.taxable` from the saved snapshot.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const { orderId } = req.params;
  const pg = req.scope.resolve("__pg_connection__") as any;

  const result = await pg.raw(
    `SELECT oli.id, oli.taxable
       FROM order_line_item oli
       JOIN order_item oi ON oi.item_id = oli.id
      WHERE oi.order_id = ?`,
    [orderId]
  );

  const items = (result.rows ?? []).map((r: any) => ({
    id: r.id,
    taxable: r.taxable !== false,
  }));

  return res.status(200).json({ items });
};
