/**
 * src/lib/carrier-tracking/index.ts
 *
 * Orchestrator for the carrier-tracking layer:
 *   - fetchCarrierEta(provider, number) → resolves the right adapter and returns
 *     a normalized result (auto-detects when provider is "Auto").
 *   - selectExpectedEta(entries) → picks the ETA that should drive the PO's
 *     Expected Delivery: the earliest ETA still in the future; if the closest
 *     has already passed, the next closest; if all passed, null.
 */

import { resolveCarrier } from "./detect";
import { dhlAdapter } from "./dhl";
import { fedexAdapter } from "./fedex";
import { upsAdapter } from "./ups";
import type {
  CarrierAdapter,
  CarrierTrackingResult,
  TrackingEntry,
} from "./types";
import { unavailable } from "./types";

const ADAPTERS: Record<string, CarrierAdapter> = {
  UPS: upsAdapter,
  FedEx: fedexAdapter,
  DHL: dhlAdapter,
};

/**
 * Fetch the carrier ETA for one tracking entry. `provider` is the value stored
 * on the entry ("UPS" | "FedEx" | "USPS" | "DHL" | "Auto" | "Other"); when it
 * is "Auto" the carrier is inferred from the number format.
 */
export async function fetchCarrierEta(
  provider: string,
  trackingNumber: string
): Promise<CarrierTrackingResult> {
  const carrier = resolveCarrier(provider, trackingNumber);
  if (!carrier) {
    return unavailable("No carrier API for this provider");
  }
  const adapter = ADAPTERS[carrier];
  if (!adapter) {
    // USPS: detected/selected but no adapter yet.
    return unavailable(`${carrier} tracking not supported yet`);
  }
  return adapter.track(trackingNumber);
}

/** True when the entry's stored provider/number maps to a carrier we can query. */
export function isTrackable(
  entry: Pick<TrackingEntry, "provider" | "tracking_number">
): boolean {
  const carrier = resolveCarrier(entry.provider, entry.tracking_number);
  return Boolean(carrier && ADAPTERS[carrier]);
}

/** Today's date as YYYY-MM-DD in local server time. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Choose the ETA that should populate Expected Delivery.
 *
 * Rule (per product decision): among all entries' carrier ETAs, pick the
 * earliest date that is today-or-later. If the soonest ETA already passed,
 * skip it and take the next soonest future date. If every ETA is in the past
 * (packages overdue / not yet rescanned), return null — the caller leaves
 * Expected Delivery untouched and the UI flags the shipment as late.
 */
export function selectExpectedEta(entries: TrackingEntry[]): string | null {
  const today = todayIso();
  const futureEtas = entries
    .map((e) => e.carrier_eta)
    .filter((d): d is string => Boolean(d) && /^\d{4}-\d{2}-\d{2}$/.test(d!))
    .filter((d) => d >= today)
    .sort();
  return futureEtas[0] ?? null;
}

export type { CarrierTrackingResult, TrackingEntry } from "./types";
