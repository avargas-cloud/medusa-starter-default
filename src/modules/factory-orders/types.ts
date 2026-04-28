/**
 * src/modules/factory-orders/types.ts
 * Status enums for the factory-orders module.
 *
 * Mirrors purchase-orders/types.ts but strips all QB-related lifecycle states.
 */

export const FACTORY_ORDER_STATUSES = [
  "draft",
  "submitted",
  "partially_received",
  "received",
  "closed",
  "cancelled",
  "voided",
] as const;

export type FactoryOrderStatus = (typeof FACTORY_ORDER_STATUSES)[number];

export const FACTORY_ORDER_LINE_STATUSES = [
  "open",
  "partial",
  "complete",
  "cancelled",
] as const;

export type FactoryOrderLineStatus =
  (typeof FACTORY_ORDER_LINE_STATUSES)[number];

/**
 * Receipt lifecycle (no QB sync state — stock apply is the terminal success).
 *   pending  → stock apply in progress (transient)
 *   applied  → Medusa inventory updated
 *   voided   → receipt reversed; stock contra-applied
 *   error    → stock apply failed; admin resolves manually
 */
export const FACTORY_ORDER_RECEIPT_STATUSES = [
  "pending",
  "applied",
  "voided",
  "error",
] as const;

export type FactoryOrderReceiptStatus =
  (typeof FACTORY_ORDER_RECEIPT_STATUSES)[number];
