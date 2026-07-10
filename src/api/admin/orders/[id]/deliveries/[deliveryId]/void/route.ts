/**
 * POST /admin/orders/:id/deliveries/:deliveryId/void
 *
 * Void a bought shipping label (Fase 9 of DELIVERY_FULFILLMENT_INTEGRATION_
 * PLAN.md — the "Existing Labels" section of DispatchModal exposes it as
 * "Void"). Scope is DELIBERATELY narrow: this cancels the label with the
 * carrier (stops the physical shipment / queues the label refund) and marks
 * `order_delivery.status='canceled'` + `voided_at`. It does NOT touch the
 * order's fulfillment/shipped_at/reservations — un-shipping the order is a
 * separate, bigger decision the cashier makes explicitly elsewhere (the
 * existing fulfillment/void-invoice flows), not an automatic side effect of
 * voiding a label.
 *
 * Idempotent: an already-voided delivery short-circuits to success without
 * re-calling the carrier. Delivered packages are blocked (voiding something
 * already in the recipient's hands makes no sense).
 */
import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getDbPool } from "../../../../../../utils/db-pool";
import { getDispatchAdapter } from "../../../../../../../lib/shipping-dispatch/registry";
import { DispatchError } from "../../../../../../../lib/shipping-dispatch/types";

interface DeliveryRow {
  id: string;
  order_id: string;
  provider: string;
  provider_object_id: string | null;
  status: string;
  voided_at: string | null;
  delivered_at: string | null;
}

export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const { id: orderId, deliveryId } = req.params as { id: string; deliveryId: string };
  const pool = getDbPool();

  const { rows } = await pool.query<DeliveryRow>(
    `SELECT id, order_id, provider, provider_object_id, status, voided_at, delivered_at
       FROM order_delivery
      WHERE id = $1 AND order_id = $2 AND deleted_at IS NULL`,
    [deliveryId, orderId]
  );
  const delivery = rows[0];
  if (!delivery) {
    return res.status(404).json({ error: "Delivery not found" });
  }
  if (delivery.voided_at) {
    return res.json({ voided: true, already_voided: true });
  }
  if (delivery.delivered_at) {
    return res.status(409).json({ error: "Cannot void a delivery that already reached the recipient" });
  }
  if (!delivery.provider_object_id) {
    return res.status(409).json({ error: "This delivery has no provider label to void" });
  }

  try {
    const adapter = getDispatchAdapter(delivery.provider);
    if (adapter.voidLabel) {
      await adapter.voidLabel(delivery.provider_object_id);
    }
  } catch (err) {
    const message = err instanceof DispatchError ? err.message : (err as Error).message;
    return res.status(502).json({ error: `Void failed with the carrier: ${message}` });
  }

  await pool.query(
    `UPDATE order_delivery SET status = 'canceled', voided_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [deliveryId]
  );

  return res.json({ voided: true, already_voided: false });
}
