/**
 * src/api/admin/purchase-orders/_lib/po-shipping-status.ts
 *
 * Shared constants + rule for the auto-advancing PO workflow status (`po_status`)
 * when a shipment is detected.
 *
 * Two triggers feed this (both non-fatal, both idempotent):
 *   - A tracking entry is added to the PO       → "Shipped (Waiting on Arrival)"
 *   - The linked Inventory Transfer is shipped  → tracking-aware:
 *        has tracking → "Shipped (Waiting on Arrival)"
 *        no tracking  → "Shipped (Missing Tracking)"
 *
 * These string values must match the seeded `po_status` dropdown options
 * (see scripts/migrations/seed-po-status-defaults.ts).
 */

export const PO_STATUS_SHIPPED_WAITING = "Shipped (Waiting on Arrival)";
export const PO_STATUS_SHIPPED_MISSING_TRACKING = "Shipped (Missing Tracking)";

/**
 * Lifecycle statuses where an in-transit `po_status` must NOT be auto-applied
 * (the goods already arrived or the PO is dead). `partially_received` is
 * intentionally allowed — the remaining units can still be in transit.
 */
export const PO_STATUS_AUTOSHIP_BLOCKED_LIFECYCLE = [
  "received",
  "closed",
  "cancelled",
  "voided",
];

/**
 * Resolve the shipped `po_status` given whether the PO already has a tracking
 * number on file.
 */
export function resolveShippedPoStatus(hasTracking: boolean): string {
  return hasTracking
    ? PO_STATUS_SHIPPED_WAITING
    : PO_STATUS_SHIPPED_MISSING_TRACKING;
}
