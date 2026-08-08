/**
 * POST /admin/orders/:id/create-shipment
 *
 * THE single idempotent dispatch command (plan §Fase 4). The POS calls this
 * once — never the 3-call chain (create-fulfillment-force → shipments →
 * invoice tracking) that could leave a PAID label with no shipped fulfillment
 * when a later call failed.
 *
 * Sequence (advisory-locked per order):
 *   1. Claim/reuse the order_delivery row by Idempotency-Key (required
 *      header). A retry after a mid-flight failure resumes WITHOUT re-buying:
 *      the row already holds provider_object_id + tracking.
 *   2. Buy the label via the dispatch adapter (UPS rate rule lives there).
 *   3. Reuse a pending (unshipped) fulfillment, else create one via the
 *      hardened create-fulfillment-force handler (invoked in-process).
 *   4. Ship it (createOrderShipmentWorkflow → shipped_at + labels + event →
 *      Meili reindex → order leaves the Unfulfilled tab).
 *   5. Bind tracking to the pos_invoice (invoice_tracking + fulfillment_id).
 *   6. Finalize the order_delivery row (fulfillment_id, shipped_at).
 *
 * Body:
 *   parcels: { length_in, width_in, height_in, weight_lb }[]   required
 *   service?: string        provider service token (default: cheapest UPS)
 *   provider?: "shippo"     (default)
 *   invoice_id?: string     bind tracking to this pos_invoice
 *   items?: { id; quantity }[]  order line items to ship (default: pending
 *                               fulfillment's items, else all unfulfilled)
 *   location_id?: string    required only when a fulfillment must be created
 *   address_to?: DispatchAddress  override (default: order shipping address)
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { INVOICE_MODULE } from "../../../../../modules/invoices";
import { getDispatchAdapter } from "../../../../../lib/shipping-dispatch/registry";
import type {
  CreateLabelResult,
  DispatchAddress,
  DispatchParcel,
} from "../../../../../lib/shipping-dispatch/types";
import { DispatchError } from "../../../../../lib/shipping-dispatch/types";
import { resolveDispatchProvider } from "../../../../../lib/shipping-dispatch/default-provider";
import { getDbPool } from "../../../../utils/db-pool";
import { POST as createFulfillmentForce } from "../create-fulfillment-force/route";
import {
  claimDelivery,
  finalizeDelivery,
  findDeliveryByKey,
  saveLabelOnDelivery,
  setDeliveryErrorDetail,
  setDeliveryFulfillment,
} from "./_lib/delivery-store";
import { rehostLabelPdfs, type RehostedPackage } from "./_lib/rehost-labels";
import {
  findPendingFulfillment,
  isFulfillmentShipped,
  loadFulfillmentItems,
  loadOrderShipTo,
  loadUnfulfilledItems,
  type ShipItem,
} from "./_lib/resolve";

const DISPATCH_HTTP_STATUS: Record<DispatchError["code"], number> = {
  invalid_address: 400,
  no_ups_rate: 422,
  provider_error: 502,
  not_configured: 503,
};

interface CreateShipmentBody {
  parcels: DispatchParcel[];
  service?: string;
  provider?: string;
  invoice_id?: string;
  items?: ShipItem[];
  location_id?: string;
  address_to?: DispatchAddress;
  /**
   * Delivery v2: 'pool' buys the label WITHOUT creating a fulfillment or
   * shipping anything — the row stays in the order's pool (invoice_id NULL)
   * until it is assigned to an invoice (POST :id/assign-delivery), which is
   * the moment inventory moves. Buying postage is monetarily and physically
   * neutral (docs/DISPATCH_ON_ORDER_HANDOFF.md).
   */
  mode?: "pool";
}

interface InvoiceServiceShape {
  createInvoiceTrackings(input: {
    invoice_id: string;
    carrier: string | null;
    tracking_number: string;
    tracking_url: string | null;
    shipped_at: Date | null;
  }): Promise<unknown>;
  updatePosInvoices(input: { id: string; fulfillment_id: string }): Promise<unknown>;
}

/** Run the hardened create-fulfillment-force handler in-process, capturing
 * its response instead of writing to the wire. Reuses 600+ lines of POS
 * fulfillment hardening without an HTTP self-call. Also used by the
 * driver-delivery command (Local Delivery — no label to buy). */
export async function createFulfillmentInProcess(
  req: MedusaRequest,
  body: Record<string, unknown>
): Promise<{ status: number; fulfillmentId: string | null; payload: unknown }> {
  let status = 200;
  let payload: unknown = null;
  const capture = {
    status(code: number) {
      status = code;
      return capture;
    },
    json(obj: unknown) {
      payload = obj;
      return capture;
    },
    setHeader() {
      return capture;
    },
  } as unknown as MedusaResponse;

  const originalBody = req.body;
  try {
    req.body = body;
    await createFulfillmentForce(req, capture);
  } finally {
    req.body = originalBody;
  }
  const fulfillmentId =
    (payload as { fulfillment?: { id?: string } } | null)?.fulfillment?.id ?? null;
  return { status, fulfillmentId, payload };
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const orderId = req.params.id as string;
  const body = req.body as CreateShipmentBody;
  const idempotencyKey =
    typeof req.headers["idempotency-key"] === "string"
      ? req.headers["idempotency-key"].trim()
      : "";

  if (!idempotencyKey) {
    return res.status(400).json({
      code: "idempotency_key_required",
      message: "Send an Idempotency-Key header (label purchases must never double-run)",
    });
  }
  if (!Array.isArray(body.parcels) || body.parcels.length === 0) {
    return res
      .status(400)
      .json({ code: "invalid_parcels", message: "parcels[] is required" });
  }

  const invoiceService = req.scope.resolve(INVOICE_MODULE) as InvoiceServiceShape;
  const pool = getDbPool();
  const actorId =
    (req as { auth_context?: { actor_id?: string } }).auth_context?.actor_id ?? null;

  const provider = await resolveDispatchProvider(pool, body.provider);

  const lockClient = await pool.connect();
  try {
    await lockClient.query("BEGIN");
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
    if (existing?.shipped_at) {
      // Fully completed earlier — replay.
      await lockClient.query("COMMIT");
      return res.status(200).json({ delivery: existing, replayed: true });
    }

    const isPool = body.mode === "pool";
    if (isPool && existing?.provider_object_id) {
      // Pool purchase already completed earlier — replay.
      await lockClient.query("COMMIT");
      return res
        .status(200)
        .json({ delivery: existing, pooled: true, replayed: true });
    }

    // ── 2. Resolve the shipment plan BEFORE buying anything ─────────────
    // A label must never be bought for an order with nothing to ship.
    // Pool mode skips this entirely: postage is neutral — no fulfillment, no
    // inventory. The plan is resolved later, at assignment.
    let fulfillmentId = existing?.fulfillment_id ?? null;
    let planItems: ShipItem[] = [];
    let mustCreateFulfillment = false;
    if (isPool) {
      // nothing to plan
    } else if (fulfillmentId) {
      // Resume — the fulfillment was already resolved on a prior attempt.
      planItems = await loadFulfillmentItems(pool, fulfillmentId);
    } else {
      const pending = await findPendingFulfillment(pool, orderId);
      if (pending && pending.items.length > 0) {
        // Mina 2 fix (2026-08-07): an EXPLICIT selection is never silently
        // discarded. If the caller named items and they don't match the
        // pending fulfillment exactly, refuse instead of shipping something
        // other than what was asked.
        if (body.items?.length) {
          const norm = (items: ShipItem[]) => {
            const m = new Map<string, number>();
            for (const it of items)
              m.set(it.id, (m.get(it.id) ?? 0) + Number(it.quantity));
            return m;
          };
          const asked = norm(body.items);
          const pend = norm(pending.items);
          const matches =
            asked.size === pend.size &&
            [...asked].every(([lid, q]) => pend.get(lid) === q);
          if (!matches) {
            await lockClient.query("COMMIT");
            return res.status(409).json({
              code: "pending_fulfillment_mismatch",
              message:
                "A pending fulfillment exists with a different item set — resolve it before dispatching a different selection",
              pending_fulfillment_id: pending.id,
              pending_items: pending.items,
            });
          }
        }
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
        // Validate the location EXISTS before buying: an unknown location can
        // crash deep inside the force handler (unhandled rejection) — turn it
        // into a clean 400 while nothing has been paid yet.
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
        // Pool purchases are never invoice-bound at buy time — assignment is
        // a separate, later act.
        invoice_id: isPool ? null : (body.invoice_id ?? null),
        provider,
        idempotency_key: idempotencyKey,
        created_by_user_id: actorId,
      }));

    // ── 3. Buy the label (skipped on resume — never re-buy) ─────────────
    let label: CreateLabelResult;
    let packages: RehostedPackage[];
    if (delivery.provider_object_id && delivery.tracking_number) {
      // Resume — rebuild from the persisted row (incl. per-box packages).
      label = {
        provider: delivery.provider as CreateLabelResult["provider"],
        provider_object_id: delivery.provider_object_id,
        carrier: delivery.carrier ?? "UPS",
        service: delivery.service ?? null,
        tracking_number: delivery.tracking_number,
        tracking_url: delivery.tracking_url ?? null,
        label_url: delivery.label_url ?? null,
        rate_amount_cents: delivery.rate_amount_cents ?? 0,
        rate_currency: "USD",
        packages: [],
      };
      const stored = (delivery.metadata as { packages?: RehostedPackage[] } | null)
        ?.packages;
      packages = stored?.length
        ? stored
        : [
            {
              provider_object_id: delivery.provider_object_id,
              tracking_number: delivery.tracking_number,
              tracking_url: delivery.tracking_url ?? null,
              label_url: delivery.label_url ?? null,
              provider_label_url: null,
            },
          ];
    } else {
      const adapter = getDispatchAdapter(provider);
      const address_to = body.address_to ?? (await loadOrderShipTo(pool, orderId));
      label = await adapter.createLabel({
        order_id: orderId,
        address_to,
        parcels: body.parcels,
        service: body.service,
        idempotency_key: idempotencyKey,
      });
      // Own the PDFs: pull them off the provider CDN into our storage before
      // anything else can fail — the invoice must never depend on Shippo.
      packages = await rehostLabelPdfs(req.scope, label.packages, orderId);
      const master =
        packages.find((p) => p.provider_object_id === label.provider_object_id) ??
        packages[0];
      if (master?.label_url) label.label_url = master.label_url;
      await saveLabelOnDelivery(pool, delivery.id, label, packages);
    }

    if (isPool) {
      // Pool purchase ends here: label bought + persisted, no fulfillment,
      // no inventory movement. It shows as "available" on the order until
      // assign-delivery attaches it to an invoice.
      await lockClient.query("COMMIT");
      const pooled = await findDeliveryByKey(pool, idempotencyKey);
      return res.status(201).json({ delivery: pooled, pooled: true });
    }

    // ── 4-6. Fulfillment / ship / invoice binding — every step idempotent
    // so a same-key retry resumes exactly where the last attempt died. ─────
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
        // Persist immediately: a resume must reuse this fulfillment, not mint one.
        await setDeliveryFulfillment(pool, delivery.id, fulfillmentId);
      }

      if (!(await isFulfillmentShipped(pool, fulfillmentId))) {
        const { createOrderShipmentWorkflow } = await import("@medusajs/core-flows");
        await createOrderShipmentWorkflow(req.scope).run({
          input: {
            order_id: orderId,
            fulfillment_id: fulfillmentId,
            items: planItems,
            // One label entry per box — each package has its own tracking.
            labels: packages.map((p) => ({
              tracking_number: p.tracking_number,
              tracking_url: p.tracking_url ?? "",
              label_url: p.label_url ?? "",
            })),
            no_notification: false,
          },
        });
      }

      const shippedAt = new Date();
      if (body.invoice_id) {
        for (const pkg of packages) {
          const dup = await pool.query(
            `SELECT 1 FROM invoice_tracking
              WHERE invoice_id = $1 AND tracking_number = $2 AND deleted_at IS NULL`,
            [body.invoice_id, pkg.tracking_number]
          );
          if (dup.rowCount === 0) {
            await invoiceService.createInvoiceTrackings({
              invoice_id: body.invoice_id,
              carrier: label.carrier,
              tracking_number: pkg.tracking_number,
              tracking_url: pkg.tracking_url,
              shipped_at: shippedAt,
            });
          }
        }
        await invoiceService.updatePosInvoices({
          id: body.invoice_id,
          fulfillment_id: fulfillmentId,
        });
      }

      const finalized = await finalizeDelivery(pool, delivery.id, {
        fulfillment_id: fulfillmentId,
        invoice_id: body.invoice_id ?? delivery.invoice_id ?? null,
        shipped_at: shippedAt,
      });
      await lockClient.query("COMMIT");
      return res.status(201).json({ delivery: finalized });
    } catch (postErr) {
      // Label IS bought — keep the row recoverable; same-key retry resumes
      // from step 3 without re-buying.
      const message = postErr instanceof Error ? postErr.message : String(postErr);
      await setDeliveryErrorDetail(
        pool,
        delivery.id,
        `post-purchase step failed: ${message}`
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
    if (err instanceof DispatchError) {
      return res
        .status(DISPATCH_HTTP_STATUS[err.code])
        .json({ code: err.code, message: err.message });
    }
    console.error("[create-shipment]", err);
    return res.status(500).json({
      code: "unknown",
      message: err instanceof Error ? err.message : "create-shipment failed",
    });
  } finally {
    lockClient.release();
  }
}
