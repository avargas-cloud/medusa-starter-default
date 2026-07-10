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
      `SELECT id, provider, carrier, service, tracking_number, tracking_url,
              label_url, rate_amount_cents, status, status_detail, invoice_id,
              fulfillment_id, shipped_at, delivered_at, voided_at, created_at,
              metadata->'packages' AS packages
         FROM order_delivery
        WHERE order_id = $1 AND deleted_at IS NULL
        ORDER BY created_at DESC`,
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
