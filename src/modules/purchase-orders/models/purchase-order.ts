import { model } from "@medusajs/utils";

/**
 * Header for a purchase order.
 *
 * Lifecycle:
 *   draft               → admin is filling lines (no number allocated yet)
 *   submitted           → PO# allocated, vendor snapshot frozen, QB enqueued
 *   partially_received  → at least one receipt, qty_received < qty_ordered
 *   received            → all ordered qty has been received
 *   closed              → admin closed the PO manually (unreceived qty forfeited)
 *   cancelled           → cancelled before any receipt (soft clean-up)
 *   voided              → previously-received PO reversed end-to-end
 *
 * Snapshot rule: once status leaves `draft`, vendor_* fields and all line
 * pricing are immutable. The PO represents a commercial commitment.
 */
export const PurchaseOrder = model.define("purchase_order", {
  id: model.id({ prefix: "po" }).primaryKey(),

  // Numbering — PO-{seq} e.g. PO-1001
  // Allocated at CREATION time from the `custom_purchase_order_seq` Postgres
  // sequence so drafts carry a stable human-readable identifier staff can
  // reference before QuickBooks submission. Nullable only for legacy rows
  // created before this change.
  number: model.text().nullable(),
  seq: model.number().nullable(),

  status: model.text().default("draft"),

  // User-managed workflow status (independent of `status`). Values come from
  // the system_defaults "PO Status" field — e.g. "PO Sent", "US Customs Delay".
  // Nullable: drafts/legacy rows have no tag.
  po_status: model.text().nullable(),

  // Vendor — FK into quickbooks-catalog.qb_vendor (soft reference; no cascade)
  vendor_id: model.text(),
  // Snapshots frozen at submit time so future vendor edits don't mutate PO
  vendor_name_snapshot: model.text().nullable(),
  vendor_qb_list_id_snapshot: model.text().nullable(),

  // Destination stock location (header-level; MVP = single location per PO)
  stock_location_id: model.text(),

  // Dates
  ordered_at: model.dateTime().nullable(),
  expected_at: model.dateTime().nullable(),

  // Totals in cents (USD only in MVP; currency column reserved for future)
  subtotal_cents: model.number().default(0),
  tax_cents: model.number().default(0),
  shipping_cents: model.number().default(0),
  other_fees_cents: model.number().default(0),
  total_cents: model.number().default(0),
  currency_code: model.text().default("usd"),

  // Draft reference — D-{n}, assigned at creation and never overwritten.
  // Persists after submit so staff can always say "check D-3" even after
  // the PO becomes PO-1005.
  draft_number: model.text().nullable(),

  // Free-text
  memo: model.text().nullable(),
  // Vendor's own PO reference number, if any (e.g. sales order # from vendor)
  reference_number: model.text().nullable(),
  // JSON array of Medusa order IDs linked to this PO (e.g. orders this PO fulfills)
  linked_order_ids: model.text().nullable(),

  // Logistics / terms — editable at any lifecycle stage
  shipping_method: model.text().nullable(),
  payment_terms: model.text().nullable(),

  // Audit — creation
  created_by_user_id: model.text(),

  // Audit — submit
  submitted_at: model.dateTime().nullable(),
  submitted_by_user_id: model.text().nullable(),

  // Audit — close (happens when admin forces close with remaining qty open)
  closed_at: model.dateTime().nullable(),
  closed_by_user_id: model.text().nullable(),
  close_reason: model.text().nullable(),

  // Audit — cancel (pre-receipt abort)
  cancelled_at: model.dateTime().nullable(),
  cancelled_by_user_id: model.text().nullable(),
  cancel_reason: model.text().nullable(),

  // Audit — void (post-receipt reversal)
  voided_at: model.dateTime().nullable(),
  voided_by_user_id: model.text().nullable(),
  void_reason: model.text().nullable(),

  // Denormalized counters refreshed on line changes + receipt events
  total_lines: model.number().default(0),
  total_units_ordered: model.number().default(0),
  total_units_received: model.number().default(0),

  // QB sync — header-level PurchaseOrderAdd
  qb_purchase_order_list_id: model.text().nullable(), // TxnID
  qb_purchase_order_txn_number: model.text().nullable(),
  qb_synced_at: model.dateTime().nullable(),
});
