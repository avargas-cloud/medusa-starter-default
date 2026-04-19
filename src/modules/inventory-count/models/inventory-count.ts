import { model } from "@medusajs/utils";

import { DEFAULT_QB_INVENTORY_ADJUSTMENT_ACCOUNT_LIST_ID } from "../types";

/**
 * Header for a physical inventory count.
 *
 * Lifecycle:
 *   draft               → cashier is filling counted quantities
 *   submitted           → snapshot frozen, waiting for manager review
 *   approved            → all lines applied to Medusa stock + queued to QB
 *   partially_applied   → some lines blocked by projected-negative guard or skipped
 *   rejected            → terminal; cashier must create a new count
 *   cancelled           → soft-deleted draft (cleanup job after 30 days)
 *   voided              → previously approved; stock contra-applied + QB voided
 */
export const InventoryCount = model.define("inventory_count", {
  id: model.id({ prefix: "invcnt" }).primaryKey(),

  // Numbering — INVCNT-{seq} e.g. INVCNT-1001
  // Allocated at submit time from the shared `custom_inventory_count_seq`
  // Postgres sequence (matches custom_estimate_seq / *_seq convention).
  // Null while status='draft'.
  number: model.text().nullable(),
  year: model.number().nullable(),
  seq: model.number().nullable(),

  status: model.text().default("draft"),

  // Scope
  stock_location_id: model.text(),
  category_filter_id: model.text().nullable(),
  sku_prefix_filter: model.text().nullable(),

  // Memo travels to QB as <Memo> on the InventoryAdjustment. Required at submit.
  memo: model.text().nullable(),

  // Default account for all lines (manager may override per-line during approval)
  default_qb_account_list_id: model
    .text()
    .default(DEFAULT_QB_INVENTORY_ADJUSTMENT_ACCOUNT_LIST_ID),

  // Audit
  created_by_user_id: model.text(),
  submitted_at: model.dateTime().nullable(),
  reviewed_by_user_id: model.text().nullable(),
  reviewed_at: model.dateTime().nullable(),
  review_notes: model.text().nullable(),
  applied_at: model.dateTime().nullable(),
  qb_synced_at: model.dateTime().nullable(),
  voided_at: model.dateTime().nullable(),
  voided_by_user_id: model.text().nullable(),
  void_reason: model.text().nullable(),

  // Denormalized counters refreshed at submit/approve for cheap list rendering
  total_lines: model.number().default(0),
  total_lines_applied: model.number().default(0),
  total_lines_blocked: model.number().default(0),
  total_delta_units: model.number().default(0),
});
