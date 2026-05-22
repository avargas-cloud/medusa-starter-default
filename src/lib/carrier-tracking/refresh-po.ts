/**
 * src/lib/carrier-tracking/refresh-po.ts
 *
 * Shared "refresh carrier ETAs for one PO" routine used by both the on-demand
 * endpoint (POST /admin/purchase-orders/:id/tracking/refresh) and the cron job.
 *
 * It re-fetches the ETA for every non-delivered tracking entry, writes the
 * enriched entries back, and — only if Expected Delivery is currently empty —
 * fills it with the selected ETA. A staff-entered expected_at is never
 * overwritten here (the UI offers an explicit "Apply" action for that).
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
 * @param forceApply when true, set Expected Delivery to the selected ETA even
 *   if a date is already present (the explicit "Apply" action from the UI).
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

  // Auto-fill Expected Delivery ONLY when it's currently empty.
  const expectedEmpty = po.expected_at === null || po.expected_at === "";
  let expectedAtOut: string | null = expectedEmpty
    ? null
    : new Date(po.expected_at as string | Date).toISOString();

  const update: Record<string, unknown> = { id: po.id, tracking: next };
  if (selected && (expectedEmpty || forceApply)) {
    update.expected_at = new Date(`${selected}T00:00:00.000Z`);
    expectedAtOut = (update.expected_at as Date).toISOString();
    changed = true;
  }

  await service.updatePurchaseOrders([update]);

  return { tracking: next, expected_at: expectedAtOut, changed };
}
