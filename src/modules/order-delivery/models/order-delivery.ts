import { model } from "@medusajs/utils";

/**
 * One outbound customer shipment (a bought label or a courier dispatch).
 *
 * An order can have several of these (partial shipments, multi-package,
 * voided + re-bought labels), so the delivery lifecycle lives here — NOT in
 * `order.metadata` (deep-merge JSONB gotcha 2026-05-30). Meili only mirrors
 * an aggregated `delivery_status` per order for the [Deliveries] tab.
 *
 * Native tracking keeps being written to `fulfillment.labels[]` (source of
 * `shipped_at`) and `invoice_tracking` (POS display); this table is the
 * source of truth for the shipment lifecycle itself.
 */
export const OrderDelivery = model.define("order_delivery", {
  id: model.id({ prefix: "odel" }).primaryKey(),

  order_id: model.text(),
  fulfillment_id: model.text().nullable(),
  invoice_id: model.text().nullable(),

  // ── Delivery v2: pool + explicit invoice assignment ────────────────────────
  // A label bought from the ORDER page has invoice_id NULL = "available in the
  // order's pool". Assigning it to an invoice (the dispatch act) stamps the
  // three fields below and creates the fulfillment. 'entire_invoice' covers
  // every line of the invoice; 'items' enumerates order_delivery_line rows.
  invoice_scope: model.text().nullable(), // 'entire_invoice' | 'items'
  assigned_at: model.dateTime().nullable(),
  assigned_by_user_id: model.text().nullable(),

  // Dispatch provider that sold/arranged the shipment: shippo | ups | uber.
  // 'manual' = tracking number typed by hand (TrackingModal), no label bought
  // and no dispatch adapter — provider_object_id stays null for these rows.
  provider: model.text(),
  // Provider-side object id (Shippo transaction id / Uber delivery id).
  // Needed for void/refund. NEVER exposed to the storefront.
  provider_object_id: model.text().nullable(),

  // Actual carrier moving the package (UPS/USPS/FedEx… or "uber").
  carrier: model.text().nullable(),
  tracking_number: model.text().nullable(),
  // Provider-hosted live tracking page (customer-safe once host-validated).
  tracking_url: model.text().nullable(),
  // Label PDF — internal/POS only, never exposed to the storefront.
  label_url: model.text().nullable(),
  // Carrier service level (e.g. "ups_ground").
  service: model.text().nullable(),
  // Rate charged, in cents. Per plan §2 this is ALWAYS the UPS rate when the
  // label is brokered through Shippo.
  rate_amount_cents: model.number().nullable(),

  // DeliveryStatus state machine (lib/shipping-dispatch/status.ts):
  // label_created → pending_pickup → in_transit → out_for_delivery →
  // delivered, plus exception | failed | canceled branches.
  status: model.text().default("label_created"),
  status_detail: model.text().nullable(),

  shipped_at: model.dateTime().nullable(),
  delivered_at: model.dateTime().nullable(),
  voided_at: model.dateTime().nullable(),
  // Last time the poll cron refreshed this row (bounds/backoff live on the job).
  status_checked_at: model.dateTime().nullable(),

  // Dedup key of the create-shipment command — a retry with the same key must
  // NOT re-buy the label (unique partial index in the migration).
  idempotency_key: model.text().nullable(),

  created_by_user_id: model.text().nullable(),

  // Small provider payload snapshot for diagnostics (rate object, messages).
  metadata: model.json().nullable(),
});
