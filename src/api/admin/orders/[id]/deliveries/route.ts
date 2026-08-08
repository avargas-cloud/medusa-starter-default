/**
 * GET /admin/orders/:id/deliveries
 *
 * Shipment history of an order (order_delivery rows, newest first). Powers
 * the "Existing labels" section of the DispatchModal — reprint = re-serve the
 * STORED label_url (plan Fase 9), never re-buy and never log into the
 * provider. label_url is POS/admin-only; the storefront read (Fase 7) must
 * NOT reuse this route.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { getDbPool } from "../../../../utils/db-pool";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const orderId = req.params.id as string;
  try {
    const { rows } = await getDbPool().query(
      `SELECT od.id, od.provider, od.carrier, od.service, od.tracking_number,
              od.tracking_url, od.label_url, od.rate_amount_cents, od.status,
              od.status_detail, od.invoice_id, od.invoice_scope, od.assigned_at,
              od.fulfillment_id, od.shipped_at, od.delivered_at, od.voided_at,
              od.created_at,
              od.metadata->'packages' AS packages,
              (SELECT COALESCE(json_agg(json_build_object(
                        'order_line_item_id', odl.order_line_item_id,
                        'quantity', odl.quantity) ORDER BY odl.id), '[]'::json)
                 FROM order_delivery_line odl
                WHERE odl.delivery_id = od.id AND odl.deleted_at IS NULL) AS lines
         FROM order_delivery od
        WHERE od.order_id = $1 AND od.deleted_at IS NULL
        ORDER BY od.created_at DESC`,
      [orderId]
    );
    return res.json({ deliveries: rows });
  } catch (err) {
    console.error("[order-deliveries]", err);
    return res.status(500).json({
      code: "unknown",
      message: err instanceof Error ? err.message : "Failed to load deliveries",
    });
  }
}
