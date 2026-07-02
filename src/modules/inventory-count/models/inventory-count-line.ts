import { model } from "@medusajs/utils";

/**
 * One line per product variant inside an inventory count.
 *
 * Snapshot rule:
 *   qty_at_count_time + delta_original are FROZEN at submit time and never
 *   recomputed afterwards. delta_applied is set at approval time and may
 *   differ if the manager overrode the value.
 *
 * Delta is movement-invariant at approval time:
 *   projected_stock = current_stock_now + delta_original
 *   The original counted delta is preserved through any sales (stock down)
 *   or PO receipts (stock up) that happened during the approval window — the
 *   adjustment only applies its own correction on top of live stock.
 *   Negative results are ALLOWED (e.g. a unit sold before its PO receipt was
 *   recorded → transient negative that self-heals on receive; QB Desktop
 *   permits negative inventory). They are never blocked; `resulted_negative`
 *   flags them for review so a persistent (non-self-healing) negative can be
 *   noticed without halting the count.
 *

 * QB account override:
 *   qb_account_list_id is null by default and inherits the count header's
 *   default_qb_account_list_id. Managers may move individual lines to a
 *   different sub-account (e.g. "Adjustment Inventory:Damaged Goods") at
 *   approval time. The QB sync emits one InventoryAdjustmentAdd per
 *   distinct account group.
 */
export const InventoryCountLine = model.define("inventory_count_line", {
  id: model.id({ prefix: "invcnl" }).primaryKey(),

  inventory_count_id: model.text(),
  product_variant_id: model.text(),
  inventory_item_id: model.text(),

  // Snapshotted at submit so audit survives variant edits
  sku: model.text(),
  product_title: model.text(),

  // Counting
  // qty_counted is the TOTAL physical count = qty_counted_available +
  // qty_counted_reserved. It remains the single source of truth for the delta
  // math (delta = qty_counted − qty_at_count_time, where qty_at_count_time =
  // stocked_quantity which already includes reserved). The two components below
  // capture WHERE the clerk found each unit so the reserved ("apartados") shelf
  // is never silently skipped.
  qty_counted: model.number().nullable(),
  // Floor / shelf count (maps to available = stocked − reserved).
  qty_counted_available: model.number().nullable(),
  // Reserved / holding-area ("apartados") count (maps to reserved_quantity).
  // Required at submit whenever the system shows reserved > 0 for the item.
  qty_counted_reserved: model.number().nullable(),
  // Snapshot of the system reserved_quantity at submit — audit + drives the
  // "reserved was required" validation.
  reserved_at_count_time: model.number().nullable(),
  qty_at_count_time: model.number().nullable(),
  delta_original: model.number().nullable(),
  delta_applied: model.number().nullable(),
  qty_at_apply_time: model.number().nullable(),
  projected_stock: model.number().nullable(),

  // Staleness detection (Phase 2): a counted line whose stock moves during the
  // open draft (e.g. a sale ships mid-count) is flagged for re-count so it can't
  // silently produce a wrong delta against a stale baseline.
  counted_at: model.dateTime().nullable(),
  stocked_at_count: model.number().nullable(),
  needs_recount: model.boolean().default(false),
  stock_moved_at: model.dateTime().nullable(),
  stocked_after_movement: model.number().nullable(),

  // Per-line state
  status: model.text().default("pending"),
  block_reason: model.text().nullable(),
  override_note: model.text().nullable(),
  // True when applying delta_original drove on-hand below 0. Non-blocking:
  // surfaced in the UI so a persistent negative (real data error) gets noticed.
  resulted_negative: model.boolean().default(false),

  // QB
  qb_account_list_id: model.text().nullable(),
  qb_line_index: model.number().nullable(),
  qb_synced_at: model.dateTime().nullable(),
  qb_last_error: model.text().nullable(),
});
