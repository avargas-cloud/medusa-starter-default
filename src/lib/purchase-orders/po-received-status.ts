/**
 * src/lib/purchase-orders/po-received-status.ts
 *
 * Pure derivation of the display `po_status` from receiving progress. Neutral
 * (no container / DB deps) so it can be called from both workflow steps and API
 * routes without a cross-layer import.
 *
 * Companion to `api/admin/purchase-orders/_lib/po-shipping-status.ts`, which
 * covers the *in-transit* half of the workflow status (tracking-driven). This
 * module covers the *arrival* half (receipt-driven):
 *
 *   fully received (received >= ordered, ordered > 0) → "Fully Received"
 *   partially received (received > 0)                 → "Partial Rcvd Pending Partial"
 *   nothing received yet (received === 0)             → tracking-aware:
 *        has tracking → "Shipped (Waiting on Arrival)"
 *        no tracking  → "To Arrange Delivery"
 *
 * These string values MUST match the seeded "PO Status" dropdown options
 * (see scripts/migrations/seed-po-status-defaults.ts).
 */

export const PO_STATUS_CREATED = "PO Created";
export const PO_STATUS_SENT = "PO Sent";
export const PO_STATUS_FULLY_RECEIVED = "Fully Received";
export const PO_STATUS_PARTIAL_RECEIVED = "Partial Rcvd Pending Partial";
export const PO_STATUS_TO_ARRANGE_DELIVERY = "To Arrange Delivery";
export const PO_STATUS_SHIPPED_WAITING = "Shipped (Waiting on Arrival)";

/**
 * The `po_status` values that are AUTO-set by receiving progress. A change that
 * drops received units back to zero (receipt void / delete) may only rewrite one
 * of these — never a manually-curated tag like "US Customs Delay" / "Need Labor".
 */
export const PO_STATUS_RECEIVED_DRIVEN_SET: readonly string[] = [
  PO_STATUS_FULLY_RECEIVED,
  PO_STATUS_PARTIAL_RECEIVED,
];

/**
 * Lifecycle statuses where a receipt-driven `po_status` must NOT be applied
 * (the PO is dead). Unlike the shipping blocked-set, `received` is NOT here —
 * a fully-received PO is exactly when we want to stamp "Fully Received".
 */
export const PO_STATUS_RECEIVE_BLOCKED_LIFECYCLE: readonly string[] = [
  "closed",
  "cancelled",
  "voided",
];

/**
 * The correct receipt-driven `po_status` for the given receiving progress.
 * `hasTracking` only matters when nothing has been received yet.
 */
export function resolveReceivedPoStatus(
  totalOrdered: number,
  totalReceived: number,
  hasTracking: boolean
): string {
  if (totalOrdered > 0 && totalReceived >= totalOrdered) {
    return PO_STATUS_FULLY_RECEIVED;
  }
  if (totalReceived > 0) {
    return PO_STATUS_PARTIAL_RECEIVED;
  }
  return hasTracking ? PO_STATUS_SHIPPED_WAITING : PO_STATUS_TO_ARRANGE_DELIVERY;
}

/**
 * Decide the new `po_status` after a receipt event or a line change, or `null`
 * when it must not change.
 *
 * Write rule:
 *   - Any received units on the PO → the receiving state dominates, so we set
 *     the accurate "Fully Received" / "Partial Rcvd Pending Partial".
 *   - Zero received → only correct a value that was previously receipt-driven
 *     (e.g. a fully-received PO whose last receipt was voided → back to
 *     "Shipped (Waiting on Arrival)" / "To Arrange Delivery"). A manual/pre-
 *     arrival tag such as "PO Created" is left untouched.
 *
 * Returns `null` for terminal lifecycles, when no write is warranted, or when
 * the target already equals the current value.
 */
export function reconcileReceivedPoStatus(
  currentPoStatus: string | null,
  lifecycleStatus: string,
  totalOrdered: number,
  totalReceived: number,
  hasTracking: boolean
): string | null {
  if (PO_STATUS_RECEIVE_BLOCKED_LIFECYCLE.includes(lifecycleStatus)) return null;

  const shouldWrite =
    totalReceived > 0 ||
    PO_STATUS_RECEIVED_DRIVEN_SET.includes(currentPoStatus ?? "");
  if (!shouldWrite) return null;

  const target = resolveReceivedPoStatus(
    totalOrdered,
    totalReceived,
    hasTracking
  );
  return target === currentPoStatus ? null : target;
}

/** True when the PO has at least one tracking entry on file. */
export function poHasTracking(tracking: unknown): boolean {
  return Array.isArray(tracking) && tracking.length > 0;
}
