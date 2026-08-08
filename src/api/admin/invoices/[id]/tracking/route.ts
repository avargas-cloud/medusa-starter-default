/**
 * src/api/admin/invoices/[id]/tracking/route.ts
 * POST /admin/invoices/:id/tracking — Add tracking info to an invoice
 */

import { generateEntityId } from "@medusajs/utils";
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { INVOICE_MODULE } from "../../../../../modules/invoices";
import { getDbPool } from "../../../../utils/db-pool";

interface TrackingBody {
  carrier?: string;
  tracking_number: string;
  tracking_url?: string;
  shipped_at?: string; // ISO date string
  fulfillment_id?: string; // Native Medusa fulfillment link
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const invoiceService = req.scope.resolve(INVOICE_MODULE);
  const id = req.params.id!;
  const body = req.body as TrackingBody;

  if (!body.tracking_number) {
    return res.status(400).json({ error: "tracking_number is required" });
  }

  let invoice: Awaited<ReturnType<typeof invoiceService.retrievePosInvoice>>;
  try {
    invoice = await invoiceService.retrievePosInvoice(id);
  } catch {
    return res.status(404).json({ error: "Invoice not found" });
  }

  const tracking = await invoiceService.createInvoiceTrackings({
    invoice_id: id,
    carrier: body.carrier ?? null,
    tracking_number: body.tracking_number,
    tracking_url: body.tracking_url ?? null,
    shipped_at: body.shipped_at ? new Date(body.shipped_at) : null,
  });

  // If a fulfillment relationship was provided during tracking creation, persist it to the Invoice
  if (body.fulfillment_id) {
    await invoiceService.updatePosInvoices({
      id,
      fulfillment_id: body.fulfillment_id,
    });
  }

  // A manually-typed tracking number has no bought label, so it never touches
  // order_delivery through create-shipment — but the [Deliveries] tab (GET
  // /admin/invoices?delivery_active=1) only reads that table. Without this
  // row a manually-tracked order silently never shows up there. provider:
  // 'manual' has no dispatch adapter and no provider_object_id, so the void
  // route's carrier-void step (gated on provider_object_id) safely no-ops for
  // these rows. status: 'in_transit' — a tracking number was just typed in
  // because the package already left, so "In Transit" is accurate (and is
  // the badge InvoiceTableRow renders for any non-terminal status anyway).
  // EXCEPT untrackable carriers ('Other', and 'USPS' — no lookup adapter in
  // lib/carrier-tracking, fetchCarrierEta returns 'unavailable'): nothing can
  // ever advance the row, so it would sit 'in_transit' forever — it is born
  // 'delivered' instead (business rule: untrackable manual shipments count as
  // delivered on entry).
  try {
    const pool = getDbPool();
    const actorId =
      (req as { auth_context?: { actor_id?: string } }).auth_context
        ?.actor_id ?? null;
    const carrierKey = (body.carrier ?? "").trim().toLowerCase();
    const isUntrackable = carrierKey === "other" || carrierKey === "usps";
    await pool.query(
      `INSERT INTO order_delivery
         (id, order_id, fulfillment_id, invoice_id, provider, carrier,
          tracking_number, tracking_url, status, shipped_at, delivered_at,
          invoice_scope, assigned_at, assigned_by_user_id,
          created_by_user_id)
       VALUES ($1, $2, $3, $4, 'manual', $5, $6, $7, $8, now(),
               CASE WHEN $8 = 'delivered' THEN now() END,
               'entire_invoice', now(), $9, $9)`,
      [
        generateEntityId("", "odel"),
        invoice.order_id,
        body.fulfillment_id ?? null,
        id,
        body.carrier ?? null,
        body.tracking_number,
        body.tracking_url ?? null,
        isUntrackable ? "delivered" : "in_transit",
        actorId,
      ]
    );
  } catch (err) {
    console.error(
      "[invoice-tracking] Failed to create order_delivery row:",
      err
    );
  }

  return res.status(201).json({ tracking });
}
