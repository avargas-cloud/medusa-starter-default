/**
 * src/lib/carrier-tracking/refresh-po.ts
 *
 * Shared "refresh carrier ETAs for one PO" routine used by both the on-demand
 * endpoint (POST /admin/purchase-orders/:id/tracking/refresh) and the cron job.
 *
 * It re-fetches the ETA for every non-delivered tracking entry and writes the
 * enriched entries back. Policy: the carrier ETA always drives Expected
 * Delivery when one is known — it overwrites whatever was there. A manually
 * entered date is only a fallback, kept while the carrier has no ETA yet. A
 * transient lookup failure never wipes a previously known ETA.
 */

import { fetchCarrierEta, selectExpectedEta } from "./index";
import type { TrackingEntry } from "./types";

interface PoLike {
  id: string;
  expected_at: Date | string | null;
  tracking: TrackingEntry[] | null;
}

interface PoServiceLike {
  updatePurchaseOrders: (data: Record<string, unknown>[]) => Promise<unknown>;
}

export interface RefreshResult {
  tracking: TrackingEntry[];
  expected_at: string | null;
  /** True when any entry's ETA/status changed or expected_at was filled. */
  changed: boolean;
}

/** Statuses we don't re-query (terminal at the carrier). */
const SKIP_REFETCH = new Set(["delivered"]);

/**
 * @param forceApply reserved for the explicit "Apply" action from the UI; with
 *   the carrier-wins policy the ETA is applied automatically, so this only
 *   forces an idempotent re-write.
 */
export async function refreshPoTrackingEta(
  service: PoServiceLike,
  po: PoLike,
  forceApply = false
): Promise<RefreshResult> {
  const entries = Array.isArray(po.tracking) ? po.tracking : [];
  if (entries.length === 0) {
    return { tracking: [], expected_at: null, changed: false };
  }

  const now = new Date().toISOString();
  let changed = false;

  const next: TrackingEntry[] = await Promise.all(
    entries.map(async (entry) => {
      if (SKIP_REFETCH.has(entry.carrier_status)) return entry;

      const result = await fetchCarrierEta(
        entry.provider,
        entry.tracking_number
      );

      // A transient failure ("error") or "no data yet" ("unavailable") returns
      // a null ETA. Don't let a single bad poll wipe a previously known ETA —
      // keep the last good value + status, only record the note and fetch time.
      // (With a daily cron, blanking would otherwise persist for up to a day.)
      const softNull =
        result.estimated_delivery === null &&
        (result.status === "error" || result.status === "unavailable");
      if (softNull && entry.carrier_eta !== null) {
        if (result.detail !== entry.carrier_detail) changed = true;
        return {
          ...entry,
          carrier_detail: result.detail,
          carrier_eta_fetched_at: now,
        };
      }

      if (
        result.estimated_delivery !== entry.carrier_eta ||
        result.status !== entry.carrier_status ||
        result.detail !== entry.carrier_detail
      ) {
        changed = true;
      }
      return {
        ...entry,
        carrier_eta: result.estimated_delivery,
        carrier_status: result.status,
        carrier_detail: result.detail,
        carrier_eta_fetched_at: now,
      };
    })
  );

  const selected = selectExpectedEta(next);

  const currentExpected =
    po.expected_at === null || po.expected_at === ""
      ? null
      : new Date(po.expected_at as string | Date).toISOString().slice(0, 10);

  let expectedAtOut: string | null =
    currentExpected === null
      ? null
      : new Date(po.expected_at as string | Date).toISOString();

  // Policy (product decision 2026-07-02): the carrier ETA always drives
  // Expected Delivery when known, overwriting any prior value; a manual date is
  // only a fallback used while the carrier has no ETA. forceApply just forces an
  // idempotent re-write from the explicit "Apply" action.
  const update: Record<string, unknown> = { id: po.id, tracking: next };
  if (selected && (selected !== currentExpected || forceApply)) {
    update.expected_at = new Date(`${selected}T00:00:00.000Z`);
    expectedAtOut = (update.expected_at as Date).toISOString();
    changed = true;
  }

  await service.updatePurchaseOrders([update]);

  return { tracking: next, expected_at: expectedAtOut, changed };
}
