/**
 * src/lib/shipping-dispatch/status.ts
 *
 * DeliveryStatus state machine + mappers (plan §Fase 0).
 *
 * Rules:
 *  - Forward-only along the happy path (label_created → pending_pickup →
 *    in_transit → out_for_delivery → delivered). A stale poll result can
 *    never move a shipment backwards.
 *  - `exception`/`failed` can be entered from any non-terminal state and can
 *    recover forward (carrier resolves the exception).
 *  - `delivered` and `canceled` are terminal — no transition leaves them.
 */

import type { CarrierStatus } from "../carrier-tracking/types";
import type { DeliveryStatus } from "./types";

export const TERMINAL_DELIVERY_STATUSES: readonly DeliveryStatus[] = [
  "delivered",
  "canceled",
];

/** Happy-path progression rank. Attention states sit outside the rank. */
const RANK: Record<DeliveryStatus, number> = {
  label_created: 0,
  pending_pickup: 1,
  in_transit: 2,
  out_for_delivery: 3,
  delivered: 4,
  // Attention branches — reachable from any non-terminal state.
  exception: -1,
  failed: -1,
  canceled: -1,
};

export function isTerminalDeliveryStatus(status: DeliveryStatus): boolean {
  return TERMINAL_DELIVERY_STATUSES.includes(status);
}

/**
 * Whether `next` is a legal transition from `current`. Idempotent updates
 * (same status) are allowed — the caller may still refresh `status_detail`.
 */
export function canTransition(
  current: DeliveryStatus,
  next: DeliveryStatus
): boolean {
  if (current === next) return true;
  if (isTerminalDeliveryStatus(current)) return false;
  // Attention branches are always reachable from a non-terminal state…
  if (next === "exception" || next === "failed" || next === "canceled") {
    return true;
  }
  // …and recovery from them goes to any happy-path state.
  if (current === "exception" || current === "failed") {
    return RANK[next] >= 0;
  }
  // Happy path: forward only (never regress on a stale poll).
  return RANK[next] > RANK[current];
}

/**
 * Apply a probe result to the current status. Returns the status to persist,
 * or null when the update must be ignored (illegal/backwards transition).
 */
export function applyStatusUpdate(
  current: DeliveryStatus,
  next: DeliveryStatus
): DeliveryStatus | null {
  return canTransition(current, next) ? next : null;
}

/**
 * Map a lib/carrier-tracking probe (UPS/FedEx/DHL parcel lookup by tracking
 * number) onto the delivery state machine. Returns null when the probe says
 * nothing actionable (no data / transient error) — the row keeps its status
 * and the cron's backoff bookkeeping handles retries.
 */
export function deliveryStatusFromCarrier(
  carrierStatus: CarrierStatus
): DeliveryStatus | null {
  switch (carrierStatus) {
    case "in_transit":
      return "in_transit";
    case "delivered":
      return "delivered";
    case "pending": // no scan yet — label exists, carrier hasn't seen it
    case "unavailable": // no API/data for this carrier
    case "error": // transient lookup failure
      return null;
  }
}
