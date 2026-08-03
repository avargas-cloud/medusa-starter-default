/**
 * src/lib/carrier-tracking/types.ts
 *
 * Shared types for the carrier-tracking layer. Each carrier (UPS / FedEx /
 * DHL) implements `CarrierAdapter`; the orchestrator (index.ts) resolves the
 * right adapter from the provider (or auto-detects it) and returns a
 * normalized `CarrierTrackingResult`.
 *
 * This layer is read-only against carrier APIs and never writes to the PO —
 * persistence lives in refresh-po.ts.
 */

/** Lifecycle of a single tracking entry as far as the carrier reports it. */
export type CarrierStatus =
  | "pending" // not fetched yet / no scan from carrier yet
  | "in_transit" // moving, ETA may be known
  | "delivered" // carrier confirms delivered (estimated_delivery = actual date)
  | "unavailable" // carrier has no API or no data (freight, USPS w/o creds, Other)
  | "error"; // lookup failed (transient — will retry)

/** Normalized result of a single carrier tracking lookup. */
export interface CarrierTrackingResult {
  /**
   * Carrier delivery date as an ISO date (YYYY-MM-DD): the ETA while in
   * transit, or the ACTUAL delivery date once delivered. null if unknown.
   */
  estimated_delivery: string | null;
  status: CarrierStatus;
  /** Human-readable note (carrier status text or error reason). */
  detail: string | null;
}

export interface CarrierAdapter {
  /** Stable provider key this adapter handles: "UPS" | "FedEx" | "DHL". */
  readonly provider: string;
  /** True when env credentials are present and the adapter can run. */
  isConfigured(): boolean;
  /** Look up a single tracking number. Never throws — returns error status. */
  track(trackingNumber: string): Promise<CarrierTrackingResult>;
}

/** Shape of a tracking entry stored in purchase_order.tracking[]. */
export interface TrackingEntry {
  id: string;
  provider: string;
  tracking_number: string;
  tracking_url: string;
  created_at: string;
  created_by_user_id: string | null;
  // Carrier ETA enrichment (added by the carrier-tracking layer).
  carrier_eta: string | null;
  // Staff-entered fallback for carriers without an API.
  manual_eta: string | null;
  carrier_status: CarrierStatus;
  carrier_eta_fetched_at: string | null;
  carrier_detail: string | null;
}

/** Automatic carrier data is authoritative; manual ETA is its fallback. */
export function effectiveTrackingEta(
  entry: Pick<TrackingEntry, "carrier_eta" | "manual_eta">
): string | null {
  return entry.carrier_eta ?? entry.manual_eta ?? null;
}

/** Builds an `unavailable` result with a reason. */
export function unavailable(detail: string): CarrierTrackingResult {
  return { estimated_delivery: null, status: "unavailable", detail };
}

/** Builds an `error` result with a reason. */
export function errored(detail: string): CarrierTrackingResult {
  return { estimated_delivery: null, status: "error", detail };
}
