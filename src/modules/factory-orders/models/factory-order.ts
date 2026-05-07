import { model } from "@medusajs/utils";

/**
 * Header for a factory order.
 *
 * Lifecycle mirrors purchase-orders exactly but has no QuickBooks integration.
 * stock_location_id is always China Warehouse (enforced by the API layer).
 *
 * Numbering: FO-{seq} allocated at submit; FOD-{seq} draft label at creation.
 */
export const FactoryOrder = model.define("factory_order", {
  id: model.id({ prefix: "fo" }).primaryKey(),

  number: model.text().nullable(),
  seq: model.number().nullable(),

  status: model.text().default("draft"),

  // User-managed workflow tag (values from system_defaults "PO Status", filtered in UI)
  po_status: model.text().nullable(),

  // Vendor — soft FK into qb_vendor (reused as factory catalog)
  vendor_id: model.text(),
  vendor_name_snapshot: model.text().nullable(),
  vendor_list_id_snapshot: model.text().nullable(),

  // Always China Warehouse — set by API layer from FACTORY_ORDER_STOCK_LOCATION_ID
  stock_location_id: model.text(),

  ordered_at: model.dateTime().nullable(),
  expected_at: model.dateTime().nullable(),

  // Totals in cents (USD)
  subtotal_cents: model.number().default(0),
  tax_cents: model.number().default(0),
  shipping_cents: model.number().default(0),
  other_fees_cents: model.number().default(0),
  total_cents: model.number().default(0),
  currency_code: model.text().default("usd"),

  // Draft label — FOD-{n}, persists after submit for staff reference
  draft_number: model.text().nullable(),

  memo: model.text().nullable(),
  reference_number: model.text().nullable(),
  linked_order_ids: model.text().nullable(),

  shipping_method: model.text().nullable(),
  payment_terms: model.text().nullable(),
  metadata: model.json().nullable(),

  created_by_user_id: model.text(),

  submitted_at: model.dateTime().nullable(),
  submitted_by_user_id: model.text().nullable(),

  closed_at: model.dateTime().nullable(),
  closed_by_user_id: model.text().nullable(),
  close_reason: model.text().nullable(),

  cancelled_at: model.dateTime().nullable(),
  cancelled_by_user_id: model.text().nullable(),
  cancel_reason: model.text().nullable(),

  voided_at: model.dateTime().nullable(),
  voided_by_user_id: model.text().nullable(),
  void_reason: model.text().nullable(),

  total_lines: model.number().default(0),
  total_units_ordered: model.number().default(0),
  total_units_received: model.number().default(0),
});
