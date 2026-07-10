/**
 * PATCH /admin/orders/:id/shipping-method-label
 *
 * Relabel the order's shipping method to match the carrier/service actually
 * used (e.g. cashier bought "UPS Next Day Air" instead of the "Standard
 * Ground" the order was created with, or a future Uber Direct swap) — called
 * by DispatchModal right after a label purchase, with the cashier's explicit
 * confirmation (this is a write to the order, so it's opt-in, not automatic).
 *
 * DELIBERATELY NAME-ONLY: this route touches `order_shipping_method.name`
 * and NOTHING else — never `amount`/`raw_amount`. What the customer was
 * charged for shipping is frozen forever on the invoice
 * (`pos_invoice.shipping`) the moment it's created; relabeling which carrier
 * actually shipped it must never touch that number. If the real shipping
 * cost differs from what was billed, that's handled as a SEPARATE charge/
 * credit (DispatchModal's "Charge additional shipping" / "Issue shipping
 * credit" buttons → a brand-new order or quick-credit, never a rewrite of
 * this order's total or the existing invoice/QB document).
 */
import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getDbPool } from "../../../../utils/db-pool";

export async function PATCH(
  req: AuthenticatedMedusaRequest<{ name?: string }>,
  res: MedusaResponse
) {
  const { id: orderId } = req.params;
  const name = req.body.name?.trim();
  if (!name) {
    return res.status(400).json({ error: "name is required" });
  }

  const pool = getDbPool();
  const { rows } = await pool.query<{ shipping_method_id: string }>(
    `SELECT osm.id AS shipping_method_id
       FROM order_shipping os
       JOIN order_shipping_method osm ON osm.id = os.shipping_method_id
       JOIN "order" o ON o.id = os.order_id AND o.version = os.version
      WHERE os.order_id = $1 AND os.deleted_at IS NULL
      ORDER BY os.created_at DESC LIMIT 1`,
    [orderId]
  );
  const shippingMethodId = rows[0]?.shipping_method_id;
  if (!shippingMethodId) {
    return res.status(404).json({ error: "Order has no active shipping method" });
  }

  await pool.query(
    `UPDATE order_shipping_method SET name = $1, updated_at = NOW() WHERE id = $2`,
    [name, shippingMethodId]
  );

  return res.json({ name });
}
