/**
 * POST /admin/orders/:id/assign-delivery
 *
 * Delivery v2 — THE dispatch act: attach a pool label (order_delivery bought
 * without an invoice) to an invoice. This is the moment the system records
 * goods leaving: it creates the fulfillment for exactly the covered units,
 * consumes reservations, ships it, and binds tracking to the invoice.
 *
 * Buying a label never touches inventory; assignment does. See
 * docs/DISPATCH_ON_ORDER_HANDOFF.md (owner model 2026-08-07).
 *
 * Body:
 *   delivery_id: string                     pool label to assign (same order)
 *   invoice_id: string                      target pos_invoice
 *   scope: 'entire_invoice' | 'items'       default 'entire_invoice'
 *   items?: { order_line_item_id, quantity }[]   required for scope 'items'
 *   location_id?: string                    default USA_LOC (fail-closed)
 *
 * Exclusivity (PO tracking pattern): one entire_invoice assignment covers the
 * whole invoice — no further assignments; item-scoped assignments may coexist
 * but never exceed each line's invoiced quantity, and block a later
 * entire_invoice (409 assignment_scope_conflict).
 *
 * Requires a 'derived_v2' invoice: legacy invoices have no line identity, so
 * assignment would have to guess — fail closed, the legacy DispatchModal flow
 * still covers them.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { USA_LOC } from "../../../../../lib/locations";
import { INVOICE_MODULE } from "../../../../../modules/invoices";
import { getDbPool } from "../../../../utils/db-pool";
import { createFulfillmentInProcess } from "../create-shipment/route";
import { getDelivery } from "../create-shipment/_lib/delivery-store";
import type { RehostedPackage } from "../create-shipment/_lib/rehost-labels";

interface AssignBody {
  delivery_id?: string;
  invoice_id?: string;
  scope?: "entire_invoice" | "items";
  items?: Array<{ order_line_item_id: string; quantity: number }>;
  location_id?: string;
}

interface InvoiceServiceShape {
  createInvoiceTrackings(input: {
    invoice_id: string;
    carrier: string | null;
    tracking_number: string;
    tracking_url: string | null;
    shipped_at: Date | null;
  }): Promise<unknown>;
  updatePosInvoices(input: {
    id: string;
    fulfillment_id: string;
  }): Promise<unknown>;
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const orderId = req.params.id as string;
  const body = req.body as AssignBody;
  const scope = body.scope ?? "entire_invoice";

  if (!body.delivery_id || !body.invoice_id) {
    return res.status(400).json({
      code: "invalid_body",
      message: "delivery_id and invoice_id are required",
    });
  }
  if (scope !== "entire_invoice" && scope !== "items") {
    return res.status(400).json({
      code: "invalid_scope",
      message: "scope must be 'entire_invoice' or 'items'",
    });
  }
  if (scope === "items" && !body.items?.length) {
    return res.status(400).json({
      code: "items_required",
      message: "items[] is required when scope is 'items'",
    });
  }

  const pool = getDbPool();
  const invoiceService = req.scope.resolve(
    INVOICE_MODULE
  ) as InvoiceServiceShape;
  const actorId =
    (req as { auth_context?: { actor_id?: string } }).auth_context?.actor_id ??
    null;

  const lockClient = await pool.connect();
  try {
    await lockClient.query("BEGIN");
    // Same lock family as label purchase/void — every physical-dispatch
    // mutation of an order serializes here.
    await lockClient.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `create-shipment:${orderId}`,
    ]);

    // ── Load + validate the two documents ────────────────────────────────
    const delivery = await getDelivery(pool, body.delivery_id);
    if (!delivery || delivery.order_id !== orderId) {
      await lockClient.query("COMMIT");
      return res.status(404).json({
        code: "delivery_not_found",
        message: "delivery does not exist on this order",
      });
    }
    if (delivery.voided_at || delivery.status === "canceled") {
      await lockClient.query("COMMIT");
      return res.status(409).json({
        code: "delivery_voided",
        message: "a voided/canceled label cannot be assigned",
      });
    }
    if (delivery.invoice_id === body.invoice_id && delivery.assigned_at) {
      await lockClient.query("COMMIT");
      return res.status(200).json({ delivery, replayed: true });
    }
    if (delivery.invoice_id) {
      await lockClient.query("COMMIT");
      return res.status(409).json({
        code: "delivery_already_assigned",
        message: "this label is already assigned to another invoice",
      });
    }
    if (!delivery.provider_object_id && delivery.provider !== "manual") {
      await lockClient.query("COMMIT");
      return res.status(409).json({
        code: "label_not_ready",
        message:
          "label purchase did not complete on this delivery (recovery required)",
      });
    }

    const invRes = await pool.query<{
      id: string;
      order_id: string;
      status: string;
      shipment_link_mode: string;
      fulfillment_id: string | null;
    }>(
      `SELECT id, order_id, status, shipment_link_mode, fulfillment_id
         FROM pos_invoice WHERE id = $1 AND deleted_at IS NULL`,
      [body.invoice_id]
    );
    const invoice = invRes.rows[0];
    if (!invoice || invoice.order_id !== orderId) {
      await lockClient.query("COMMIT");
      return res.status(404).json({
        code: "invoice_not_found",
        message: "invoice does not exist on this order",
      });
    }
    if (invoice.status === "voided") {
      await lockClient.query("COMMIT");
      return res.status(409).json({
        code: "invoice_voided",
        message: "cannot assign a label to a voided invoice",
      });
    }
    if (invoice.shipment_link_mode !== "derived_v2") {
      await lockClient.query("COMMIT");
      return res.status(409).json({
        code: "legacy_invoice",
        message:
          "this invoice predates line identity — dispatch it from the invoice's legacy flow",
      });
    }

    // ── Invoice lines (the units an assignment can cover) ────────────────
    const lineRes = await pool.query<{
      order_line_item_id: string;
      quantity: string | number;
    }>(
      `SELECT order_line_item_id, SUM(quantity)::int AS quantity
         FROM pos_invoice_item
        WHERE invoice_id = $1 AND deleted_at IS NULL
          AND order_line_item_id IS NOT NULL
        GROUP BY order_line_item_id`,
      [body.invoice_id]
    );
    const invoiceLines = new Map(
      lineRes.rows.map((r) => [r.order_line_item_id, Number(r.quantity)])
    );
    if (!invoiceLines.size) {
      await lockClient.query("COMMIT");
      return res.status(409).json({
        code: "nothing_to_dispatch",
        message: "invoice has no merchandise lines with line identity",
      });
    }

    // ── Exclusivity vs sibling assignments (PO tracking pattern) ─────────
    const siblingRes = await pool.query<{
      id: string;
      invoice_scope: string | null;
    }>(
      `SELECT id, invoice_scope FROM order_delivery
        WHERE invoice_id = $1 AND voided_at IS NULL AND deleted_at IS NULL
          AND status <> 'canceled'`,
      [body.invoice_id]
    );
    const siblings = siblingRes.rows;
    if (siblings.some((s) => s.invoice_scope === "entire_invoice")) {
      await lockClient.query("COMMIT");
      return res.status(409).json({
        code: "assignment_scope_conflict",
        message: "an entire-invoice delivery already covers this invoice",
      });
    }
    if (scope === "entire_invoice" && siblings.length > 0) {
      await lockClient.query("COMMIT");
      return res.status(409).json({
        code: "assignment_scope_conflict",
        message:
          "item-scoped deliveries already exist — assign the remaining items instead",
      });
    }

    // ── Covered units for THIS assignment ────────────────────────────────
    let units: Array<{ order_line_item_id: string; quantity: number }>;
    if (scope === "entire_invoice") {
      units = [...invoiceLines].map(([id, quantity]) => ({
        order_line_item_id: id,
        quantity,
      }));
    } else {
      // Validate against invoice lines minus what sibling deliveries cover.
      const coveredRes = await pool.query<{
        order_line_item_id: string;
        covered: string | number;
      }>(
        `SELECT odl.order_line_item_id, SUM(odl.quantity)::int AS covered
           FROM order_delivery_line odl
           JOIN order_delivery od ON od.id = odl.delivery_id
          WHERE od.invoice_id = $1 AND od.voided_at IS NULL
            AND od.deleted_at IS NULL AND od.status <> 'canceled'
            AND odl.deleted_at IS NULL
          GROUP BY odl.order_line_item_id`,
        [body.invoice_id]
      );
      const covered = new Map(
        coveredRes.rows.map((r) => [r.order_line_item_id, Number(r.covered)])
      );
      units = [];
      for (const it of body.items ?? []) {
        const qty = Number(it.quantity);
        const invoiced = invoiceLines.get(it.order_line_item_id);
        if (!invoiced) {
          await lockClient.query("COMMIT");
          return res.status(400).json({
            code: "line_not_on_invoice",
            message: `order_line_item_id ${it.order_line_item_id} is not billed by this invoice`,
          });
        }
        if (!Number.isFinite(qty) || !Number.isInteger(qty) || qty <= 0) {
          await lockClient.query("COMMIT");
          return res.status(400).json({
            code: "invalid_quantity",
            message: `invalid quantity for ${it.order_line_item_id}`,
          });
        }
        const already = covered.get(it.order_line_item_id) ?? 0;
        if (already + qty > invoiced) {
          await lockClient.query("COMMIT");
          return res.status(409).json({
            code: "over_dispatch",
            message: `line ${it.order_line_item_id}: ${already} of ${invoiced} already covered — cannot add ${qty}`,
          });
        }
        units.push({ order_line_item_id: it.order_line_item_id, quantity: qty });
      }
    }

    // ── Physical dispatch: fulfillment (consumes reservations) + ship ────
    const forced = await createFulfillmentInProcess(req, {
      items: units.map((u) => ({ id: u.order_line_item_id, quantity: u.quantity })),
      location_id: body.location_id ?? USA_LOC,
      invoice_id: body.invoice_id,
      no_notification: true,
    });
    if (!forced.fulfillmentId) {
      await lockClient.query("COMMIT");
      return res.status(502).json({
        code: "fulfillment_failed",
        message: `create-fulfillment-force failed (HTTP ${forced.status}): ${JSON.stringify(forced.payload)?.slice(0, 300)}`,
      });
    }
    const fulfillmentId = forced.fulfillmentId;

    const storedPackages =
      ((delivery.metadata as { packages?: RehostedPackage[] } | null)
        ?.packages ?? []);
    const packages: RehostedPackage[] = storedPackages.length
      ? storedPackages
      : delivery.tracking_number
        ? [
            {
              provider_object_id: delivery.provider_object_id ?? "",
              tracking_number: delivery.tracking_number,
              tracking_url: delivery.tracking_url ?? null,
              label_url: delivery.label_url ?? null,
              provider_label_url: null,
            },
          ]
        : [];

    const { createOrderShipmentWorkflow } = await import(
      "@medusajs/core-flows"
    );
    await createOrderShipmentWorkflow(req.scope).run({
      input: {
        order_id: orderId,
        fulfillment_id: fulfillmentId,
        items: units.map((u) => ({ id: u.order_line_item_id, quantity: u.quantity })),
        labels: packages.map((p) => ({
          tracking_number: p.tracking_number,
          tracking_url: p.tracking_url ?? "",
          label_url: p.label_url ?? "",
        })),
        no_notification: false,
      },
    });

    // ── Bind tracking to the invoice ─────────────────────────────────────
    const shippedAt = new Date();
    for (const pkg of packages) {
      const dup = await pool.query(
        `SELECT 1 FROM invoice_tracking
          WHERE invoice_id = $1 AND tracking_number = $2 AND deleted_at IS NULL`,
        [body.invoice_id, pkg.tracking_number]
      );
      if (dup.rowCount === 0) {
        await invoiceService.createInvoiceTrackings({
          invoice_id: body.invoice_id,
          carrier: delivery.carrier,
          tracking_number: pkg.tracking_number,
          tracking_url: pkg.tracking_url,
          shipped_at: shippedAt,
        });
      }
    }
    // First assignment wins the legacy single-fulfillment pointer (display
    // compat); later item-scoped deliveries keep their own fulfillment on
    // order_delivery, which is the v2 source of truth.
    if (!invoice.fulfillment_id) {
      await invoiceService.updatePosInvoices({
        id: body.invoice_id,
        fulfillment_id: fulfillmentId,
      });
    }

    // ── Stamp the assignment ─────────────────────────────────────────────
    await pool.query(
      `UPDATE order_delivery
          SET invoice_id = $2, invoice_scope = $3,
              assigned_at = now(), assigned_by_user_id = $4,
              fulfillment_id = $5, shipped_at = $6,
              status_detail = NULL, updated_at = now()
        WHERE id = $1`,
      [delivery.id, body.invoice_id, scope, actorId, fulfillmentId, shippedAt]
    );
    if (scope === "items") {
      for (const u of units) {
        await pool.query(
          `INSERT INTO order_delivery_line (id, delivery_id, order_line_item_id, quantity)
           VALUES ('odll_' || replace(gen_random_uuid()::text, '-', ''), $1, $2, $3)`,
          [delivery.id, u.order_line_item_id, u.quantity]
        );
      }
    }

    await lockClient.query("COMMIT");
    const finalized = await getDelivery(pool, delivery.id);
    return res.status(200).json({ delivery: finalized, fulfillment_id: fulfillmentId });
  } catch (err) {
    await lockClient.query("ROLLBACK").catch(() => undefined);
    console.error("[assign-delivery]", err);
    return res.status(500).json({
      code: "unknown",
      message: err instanceof Error ? err.message : "assign-delivery failed",
    });
  } finally {
    lockClient.release();
  }
}
