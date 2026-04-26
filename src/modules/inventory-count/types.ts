/**
 * src/modules/inventory-count/types.ts
 * Shared status enums + decision types for the inventory count workflow.
 *
 * Kept as plain string-literal unions instead of TypeScript enums to align
 * with Medusa's `model.text()` columns + DB-level CHECK constraints.
 */

export const INVENTORY_COUNT_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "partially_applied",
  "rejected",
  "cancelled",
] as const;

export type InventoryCountStatus = (typeof INVENTORY_COUNT_STATUSES)[number];

export const INVENTORY_COUNT_LINE_STATUSES = [
  "pending",
  "applied",
  "blocked",
  "skipped",
  "overridden",
  "verified", // counted by cashier, delta=0 — audit-only, no QB push
] as const;

export type InventoryCountLineStatus =
  (typeof INVENTORY_COUNT_LINE_STATUSES)[number];

export const INVENTORY_COUNT_LINE_BLOCK_REASONS = [
  "projected_negative",
  "sku_not_found",
  "location_mismatch",
] as const;

export type InventoryCountLineBlockReason =
  (typeof INVENTORY_COUNT_LINE_BLOCK_REASONS)[number];

export const QB_INV_ADJ_PIPELINE_STATUSES = [
  "waiting",
  "processing",
  "synced",
  "error",
  "cancelled",
] as const;

export type QbInvAdjPipelineStatus =
  (typeof QB_INV_ADJ_PIPELINE_STATUSES)[number];

/**
 * Manager decisions per line at approval time. Only "skip" and "override" are
 * permitted: the projected-negative guard NEVER allows force-applying a delta
 * that would leave stock negative — the entire purpose of the adjustment is
 * to fix negatives, not to create them.
 */
export const APPROVAL_LINE_ACTIONS = ["apply", "skip", "override"] as const;
export type ApprovalLineAction = (typeof APPROVAL_LINE_ACTIONS)[number];

/**
 * Default QB account for inventory adjustments. Confirmed in the production
 * Chart of Accounts as "Adjustment Inventory" (CostOfGoodsSold).
 *
 * Sub-account "Adjustment Inventory:Damaged Goods" lives at
 * 8000007C-1369921760 — managers may override individual lines to that
 * account at approval time.
 *
 * Override at runtime via env QB_INVENTORY_ADJUSTMENT_DEFAULT_ACCOUNT.
 */
export const DEFAULT_QB_INVENTORY_ADJUSTMENT_ACCOUNT_LIST_ID =
  process.env.QB_INVENTORY_ADJUSTMENT_DEFAULT_ACCOUNT ?? "8000007B-1369921375";
