/**
 * src/modules/purchase-orders/types.ts
 * Shared status enums for the purchase-orders workflow.
 *
 * Kept as plain string-literal unions instead of TypeScript enums to align
 * with Medusa's `model.text()` columns + DB-level CHECK constraints.
 */

/**
 * Header status lifecycle:
 *   draft               → admin is filling lines
 *   submitted           → frozen snapshot, PO# allocated, QB PurchaseOrderAdd queued
 *   partially_received  → at least one receipt created; qty_received < qty_ordered
 *   received            → all lines fully received (qty_received == qty_ordered)
 *   closed              → admin manually closed the PO (remaining qty cancelled)
 *   cancelled           → cancelled before any receipt (soft-deletable)
 *   voided              → previously-received PO voided; stock contra-applied,
 *                         QB ItemReceipts voided
 */
export const PURCHASE_ORDER_STATUSES = [
  "draft",
  "submitted",
  "partially_received",
  "received",
  "closed",
  "cancelled",
  "voided",
] as const;

export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

/**
 * Line status lifecycle:
 *   open       → not yet received
 *   partial    → qty_received < qty_ordered
 *   complete   → qty_received == qty_ordered
 *   cancelled  → admin cancelled the line (remaining qty zeroed)
 */
export const PURCHASE_ORDER_LINE_STATUSES = [
  "open",
  "partial",
  "complete",
  "cancelled",
] as const;

export type PurchaseOrderLineStatus =
  (typeof PURCHASE_ORDER_LINE_STATUSES)[number];

/**
 * Receipt status lifecycle:
 *   pending    → stock apply in progress (rare; transient)
 *   applied    → stock updated in Medusa, QB sync queued
 *   synced     → QB ItemReceiptAdd succeeded, qb_item_receipt_list_id set
 *   voided     → receipt reversed; stock contra-applied, QB TxnVoid queued
 *   error      → stock apply failed; needs manual resolution
 */
export const PURCHASE_ORDER_RECEIPT_STATUSES = [
  "pending",
  "applied",
  "synced",
  "voided",
  "error",
] as const;

export type PurchaseOrderReceiptStatus =
  (typeof PURCHASE_ORDER_RECEIPT_STATUSES)[number];

/**
 * QB pipeline status — shared between PurchaseOrder and ItemReceipt pipelines.
 */
export const QB_PO_PIPELINE_STATUSES = [
  "waiting",
  "processing",
  "synced",
  "error",
  "cancelled",
  "failed_permanent",
] as const;

export type QbPoPipelineStatus = (typeof QB_PO_PIPELINE_STATUSES)[number];

/**
 * QB void lifecycle — mirror of the add lifecycle on the same pipeline row.
 */
export const QB_PO_VOID_STATUSES = [
  "waiting",
  "processing",
  "voided",
  "error",
] as const;

export type QbPoVoidStatus = (typeof QB_PO_VOID_STATUSES)[number];

/**
 * Vendor Bill lifecycle:
 *   draft     → created from receipt lines; fields can be freely edited
 *   confirmed → landed costs calculated and distributed; variant metadata updated
 *   synced    → QB Vendor Bill Add succeeded (future)
 */
export const VENDOR_BILL_STATUSES = ["draft", "confirmed", "synced"] as const;

export type VendorBillStatus = (typeof VENDOR_BILL_STATUSES)[number];

export const VENDOR_BILL_TYPES = [
  "regular",
  "service",
  "freight",
  "tariff",
  "expense",
] as const;

export type VendorBillType = (typeof VENDOR_BILL_TYPES)[number];
