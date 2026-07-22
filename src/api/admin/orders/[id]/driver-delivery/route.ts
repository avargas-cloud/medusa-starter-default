/**
 * POST /admin/orders/:id/driver-delivery
 *
 * "Local Delivery" handoff — the store's own hired driver takes the goods.
 * There is no carrier, no label to buy and no tracking number: confirming the
 * handoff fulfills + ships the order and records the delivery as DELIVERED on
 * the spot (business rule: goods handed to our driver count as delivered,
 * same precedent as untrackable manual carriers in invoices/:id/tracking).
 *
 * Shares the create-shipment machinery (advisory lock, order_delivery claim
 * by Idempotency-Key, in-process create-fulfillment-force, native ship
 * workflow) minus the label purchase. provider: 'manual' — no dispatch
 * adapter, so the void route's carrier-void and the tracking cron both
 * safely no-op on these rows.
 *
 * Body:
 *   invoice_id?: string     bind the fulfillment to this pos_invoice
 *   items?: { id; quantity }[]  order line items (default: pending
 *                               fulfillment's items, else all unfulfilled)
 *   location_id?: string    required only when a fulfillment must be created
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { INVOICE_MODULE } from "../../../../../modules/invoices";
import { getDbPool } from "../../../../utils/db-pool";
import { createFulfillmentInProcess } from "../create-shipment/route";
import {
  claimDelivery,
  findDeliveryByKey,
  getDelivery,
  setDeliveryErrorDetail,
  setDeliveryFulfillment,
} from "../create-shipment/_lib/delivery-store";
import {
  findPendingFulfillment,
  isFulfillmentShipped,
  loadFulfillmentItems,
  loadUnfulfilledItems,
  type ShipItem,
} from "../create-shipment/_lib/resolve";

const CARRIER_NAME = "Local Delivery";

interface DriverDeliveryBody {
  invoice_id?: string;
  items?: ShipItem[];
  location_id?: string;
}

interface InvoiceServiceShape {
  updatePosInvoices(input: { id: string; fulfillment_id: string }): Promise<unknown>;
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const orderId = req.params.id as string;
  const body = (req.body ?? {}) as DriverDeliveryBody;
  const idempotencyKey =
    typeof req.headers["idempotency-key"] === "string"
      ? req.headers["idempotency-key"].trim()
      : "";

  if (!idempotencyKey) {
    return res.status(400).json({
      code: "idempotency_key_required",
      message: "Send an Idempotency-Key header (a handoff must never double-run)",
    });
  }

  const invoiceService = req.scope.resolve(INVOICE_MODULE) as InvoiceServiceShape;
  const pool = getDbPool();
  const actorId =
    (req as { auth_context?: { actor_id?: string } }).auth_context?.actor_id ?? null;

  const lockClient = await pool.connect();
  try {
    await lockClient.query("BEGIN");
    // Same lock family as create-shipment — a driver handoff and a label buy
    // for the same order must never race each other.
    await lockClient.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `create-shipment:${orderId}`,
    ]);

    // ── 1. Claim / resume by idempotency key ────────────────────────────
    const existing = await findDeliveryByKey(pool, idempotencyKey);
    if (existing && existing.order_id !== orderId) {
      await lockClient.query("COMMIT");
      return res.status(409).json({
        code: "idempotency_key_conflict",
        message: "Idempotency-Key was already used for another order",
      });
    }
    if (existing?.delivered_at) {
      // Fully completed earlier — replay.
      await lockClient.query("COMMIT");
      return res.status(200).json({ delivery: existing, replayed: true });
    }

    // ── 2. Resolve the shipment plan ────────────────────────────────────
    let fulfillmentId = existing?.fulfillment_id ?? null;
    let planItems: ShipItem[];
    let mustCreateFulfillment = false;
    if (fulfillmentId) {
      planItems = await loadFulfillmentItems(pool, fulfillmentId);
    } else {
      const pending = await findPendingFulfillment(pool, orderId);
      if (pending && pending.items.length > 0) {
        fulfillmentId = pending.id;
        planItems = pending.items;
      } else {
        planItems = body.items?.length
          ? body.items
          : await loadUnfulfilledItems(pool, orderId);
        if (!planItems.length) {
          await lockClient.query("COMMIT");
          return res.status(409).json({
            code: "nothing_to_ship",
            message: "No pending fulfillment and no unfulfilled items on this order",
          });
        }
        if (!body.location_id) {
          await lockClient.query("COMMIT");
          return res.status(400).json({
            code: "location_id_required",
            message: "location_id is required to create the fulfillment",
          });
        }
        const loc = await pool.query(
          `SELECT 1 FROM stock_location WHERE id = $1 AND deleted_at IS NULL`,
          [body.location_id]
        );
        if (loc.rowCount === 0) {
          await lockClient.query("COMMIT");
          return res.status(400).json({
            code: "invalid_location",
            message: `stock_location "${body.location_id}" does not exist`,
          });
        }
        mustCreateFulfillment = true;
      }
    }

    const delivery =
      existing ??
      (await claimDelivery(pool, {
        order_id: orderId,
        invoice_id: body.invoice_id ?? null,
        provider: "manual",
        idempotency_key: idempotencyKey,
        created_by_user_id: actorId,
      }));

    // ── 3-5. Fulfillment / ship / finalize — every step idempotent so a
    // same-key retry resumes exactly where the last attempt died. ─────────
    try {
      if (mustCreateFulfillment) {
        const forced = await createFulfillmentInProcess(req, {
          items: planItems,
          location_id: body.location_id,
          invoice_id: body.invoice_id,
          no_notification: true,
        });
        if (!forced.fulfillmentId) {
          throw new Error(
            `create-fulfillment-force failed (HTTP ${forced.status}): ${JSON.stringify(forced.payload)?.slice(0, 300)}`
          );
        }
        fulfillmentId = forced.fulfillmentId;
      }
      if (!fulfillmentId) {
        throw new Error("Could not resolve a fulfillment to ship");
      }
      if (fulfillmentId !== delivery.fulfillment_id) {
        await setDeliveryFulfillment(pool, delivery.id, fulfillmentId);
      }

      if (!(await isFulfillmentShipped(pool, fulfillmentId))) {
        const { createOrderShipmentWorkflow } = await import("@medusajs/core-flows");
        await createOrderShipmentWorkflow(req.scope).run({
          input: {
            order_id: orderId,
            fulfillment_id: fulfillmentId,
            items: planItems,
            labels: [], // no label, no tracking — our driver carries it
            no_notification: false,
          },
        });
      }

      if (body.invoice_id) {
        await invoiceService.updatePosInvoices({
          id: body.invoice_id,
          fulfillment_id: fulfillmentId,
        });
      }

      // Born delivered: the handoff to our driver IS the delivery event.
      await pool.query(
        `UPDATE order_delivery
            SET carrier = $2,
                status = 'delivered',
                status_detail = 'handed to our driver',
                invoice_id = COALESCE($3, invoice_id),
                shipped_at = COALESCE(shipped_at, now()),
                delivered_at = COALESCE(delivered_at, now()),
                status_checked_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [delivery.id, CARRIER_NAME, body.invoice_id ?? null]
      );
      const finalized = await getDelivery(pool, delivery.id);
      await lockClient.query("COMMIT");
      return res.status(201).json({ delivery: finalized });
    } catch (postErr) {
      // Nothing was paid, but keep the row recoverable — a same-key retry
      // resumes (reuses the fulfillment) instead of minting a second one.
      const message = postErr instanceof Error ? postErr.message : String(postErr);
      await setDeliveryErrorDetail(
        pool,
        delivery.id,
        `driver-delivery step failed: ${message}`
      );
      await lockClient.query("COMMIT");
      return res.status(502).json({
        code: "post_purchase_failed",
        message,
        delivery_id: delivery.id,
        recoverable: true,
      });
    }
  } catch (err) {
    await lockClient.query("ROLLBACK").catch(() => undefined);
    console.error("[driver-delivery]", err);
    return res.status(500).json({
      code: "unknown",
      message: err instanceof Error ? err.message : "driver-delivery failed",
    });
  } finally {
    lockClient.release();
  }
}
