import { model } from "@medusajs/utils";

/**
 * One carrier tracking number belonging to an inbound shipment.
 *
 * One delivery routinely produces several numbers — two FedEx waybills for the
 * same truck, a freight booking plus its house bill. They are labels on ONE
 * arrival, so they share the shipment's scope and its allocations rather than
 * each declaring what it carries. That is the whole reason this table is
 * separate from the shipment: without it, two numbers for one delivery had to
 * be modelled as two shipments, and two shipments both claiming the whole PO is
 * a contradiction the system now refuses.
 *
 * THE FIRST NUMBER IS THE MASTER (`is_master`). It is the one a document or a
 * customer-facing screen quotes when it has room for exactly one. Exactly one
 * master per shipment, enforced by a partial unique index.
 *
 * CARRIER STATE IS PER NUMBER, NOT PER SHIPMENT. Each number is polled on its
 * own and comes back with its own ETA and status — that is precisely how a
 * shipment ends up knowing it is not complete yet. The shipment's effective ETA
 * is the LATEST among its numbers: the delivery is not there until the last
 * piece lands. (Deliberately NOT the rule the PO header uses — see
 * lib/carrier-tracking/refresh-po.ts.)
 */
export const PurchaseOrderTrackingNumber = model.define(
  "purchase_order_tracking_number",
  {
    id: model.id({ prefix: "potrkn" }).primaryKey(),

    purchase_order_tracking_id: model.text(),
    purchase_order_id: model.text(), // denormalized for query convenience

    provider: model.text(),
    tracking_number: model.text(),
    tracking_url: model.text().default(""),

    /** The number this shipment is known by. Exactly one per shipment. */
    is_master: model.boolean().default(false),

    // Carrier ETA enrichment — written by lib/carrier-tracking, never by hand.
    carrier_eta: model.text().nullable(), // ISO date YYYY-MM-DD
    // Staff fallback for carriers without an API. Automatic ETA wins when set.
    manual_eta: model.text().nullable(), // ISO date YYYY-MM-DD
    carrier_status: model.text().default("pending"),
    carrier_eta_fetched_at: model.dateTime().nullable(),
    carrier_detail: model.text().nullable(),

    created_by_user_id: model.text().nullable(),
  }
);
