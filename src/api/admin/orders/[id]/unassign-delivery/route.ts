/**
 * POST /admin/orders/:id/unassign-delivery
 *
 * Delivery v2 — detach a label from an invoice WITHOUT voiding the invoice.
 * Supervisor-PIN gated (verified HERE, in the route — a modal only collects
 * the credential): detaching reverses a recorded dispatch, so a supervisor
 * must confirm the goods did NOT physically leave.
 *
 * Effect (shared with invoice void's error path):
 *   fulfillment reversed exactly (fulfilled/shipped counters + raw_*), stock
 *   returned, reservations recreated, label back to the order's pool. The
 *   invoice returns to "Needs dispatch".
 *
 * Body: { delivery_id: string }  ·  PIN via `x-supervisor-pin` header.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import {
  extractSupervisorPin,
  guardSupervisorPin,
  pinGuardResponse,
  resolveActorId,
} from "../../../../../lib/pos/supervisor-pin-guard";
import { pgAsPinConn } from "../../../../../lib/pos/verify-supervisor-pin";
import { getDbPool } from "../../../../utils/db-pool";
import { getDelivery } from "../create-shipment/_lib/delivery-store";
import { reverseAssignedDelivery } from "../_lib/reverse-delivery-assignment";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const orderId = req.params.id as string;
  const body = req.body as { delivery_id?: string };

  if (!body.delivery_id) {
    return res
      .status(400)
      .json({ code: "invalid_body", message: "delivery_id is required" });
  }

  const pool = getDbPool();

  const pinResult = await guardSupervisorPin({
    scope: req.scope,
    db: pgAsPinConn(pool),
    pin: extractSupervisorPin(req),
    actorId: resolveActorId(req),
  });
  if (!pinResult.ok) {
    const { status, body: payload } = pinGuardResponse(pinResult);
    return res.status(status).json(payload);
  }

  const lockClient = await pool.connect();
  try {
    await lockClient.query("BEGIN");
    await lockClient.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `create-shipment:${orderId}`,
    ]);

    const delivery = await getDelivery(pool, body.delivery_id);
    if (!delivery || delivery.order_id !== orderId) {
      await lockClient.query("COMMIT");
      return res.status(404).json({
        code: "delivery_not_found",
        message: "delivery does not exist on this order",
      });
    }
    if (!delivery.invoice_id) {
      await lockClient.query("COMMIT");
      return res.status(200).json({ delivery, replayed: true });
    }
    if (delivery.delivered_at) {
      await lockClient.query("COMMIT");
      return res.status(409).json({
        code: "delivery_delivered",
        message:
          "this package is marked delivered — it cannot be un-assigned; talk to the administrator",
      });
    }

    await reverseAssignedDelivery(
      pool,
      req.scope,
      {
        id: delivery.id,
        order_id: delivery.order_id,
        invoice_id: delivery.invoice_id,
        fulfillment_id: delivery.fulfillment_id,
        invoice_scope: delivery.invoice_scope,
        status: delivery.status,
      },
      `Un-assigned from invoice by supervisor authorization (actor ${resolveActorId(req)})`
    );

    // If this was the delivery backing the invoice's legacy single pointer,
    // clear it so the invoice reads "Not dispatched" again.
    if (delivery.fulfillment_id) {
      await pool.query(
        `UPDATE pos_invoice SET fulfillment_id = NULL, updated_at = now()
          WHERE id = $1 AND fulfillment_id = $2`,
        [delivery.invoice_id, delivery.fulfillment_id]
      );
    }

    await lockClient.query("COMMIT");
    const finalized = await getDelivery(pool, delivery.id);
    return res.status(200).json({ delivery: finalized });
  } catch (err) {
    await lockClient.query("ROLLBACK").catch(() => undefined);
    console.error("[unassign-delivery]", err);
    return res.status(500).json({
      code: "unknown",
      message: err instanceof Error ? err.message : "unassign-delivery failed",
    });
  } finally {
    lockClient.release();
  }
}
