/**
 * src/lib/carrier-tracking/refresh-po.ts
 *
 * Refreshes carrier ETAs for tracking numbers and writes them back, then
 * applies the PO header's Expected-Delivery policy.
 *
 * Used by the on-demand endpoint (POST /admin/purchase-orders/:id/tracking/
 * refresh) and by the daily cron. The cron polls MANY POs, so it calls
 * `applyEtasToNumbers` once for the whole run — one carrier call per distinct
 * (provider, number) even when a waybill covers three purchase orders — and
 * then settles each PO's header separately.
 *
 * ── The header policy, unchanged ─────────────────────────────────────────────
 * `selectExpectedEta` still takes the EARLIEST upcoming ETA and still overwrites
 * `expected_at` with it. That is deliberate, and it is NOT the rule the per-line
 * ETA uses (which takes the LATEST — see lib/purchase-orders/po-tracking-read).
 * The header feeds purchasing/snapshot, which applies that single date to every
 * open line to decide whether supply lands inside the buying window; moving it
 * to the latest delivery would push first-box goods out of the window and
 * produce over-buying suggestions. Reconciling the two is a separate decision
 * with its own verification, not a side effect of adding shipments.
 */

import { fetchUniqueEtas, lookupKey, type FetchStats } from "./refresh-numbers";
import { effectiveTrackingEta, type TrackingEntry } from "./types";

import { isTrackable, selectExpectedEta } from "./index";

/** A tracking-number row as this routine reads and writes it. */
export interface RefreshableNumber {
  id: string;
  purchase_order_id: string;
  provider: string;
  tracking_number: string;
  carrier_eta: string | null;
  manual_eta: string | null;
  carrier_status: TrackingEntry["carrier_status"];
  carrier_detail: string | null;
}

interface PoLike {
  id: string;
  expected_at: Date | string | null;
}

interface PoServiceLike {
  updatePurchaseOrders: (data: Record<string, unknown>[]) => Promise<unknown>;
}

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

export interface RefreshResult {
  tracking: RefreshableNumber[];
  expected_at: string | null;
  /** True when any number's ETA/status changed or expected_at was rewritten. */
  changed: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Live tracking numbers of one PO, in the shape this routine needs. */
export async function loadRefreshableNumbers(
  db: Knex,
  purchaseOrderId: string
): Promise<RefreshableNumber[]> {
  const result = await db.raw(
    `SELECT n.id, n.purchase_order_id, n.provider, n.tracking_number,
            n.carrier_eta, n.manual_eta, n.carrier_status, n.carrier_detail
       FROM purchase_order_tracking_number n
       JOIN purchase_order_tracking trk
         ON trk.id = n.purchase_order_tracking_id AND trk.deleted_at IS NULL
      WHERE n.purchase_order_id = ? AND n.deleted_at IS NULL
      ORDER BY n.created_at, n.id`,
    [purchaseOrderId]
  );
  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    id: row.id as string,
    purchase_order_id: row.purchase_order_id as string,
    provider: (row.provider as string) ?? "",
    tracking_number: (row.tracking_number as string) ?? "",
    carrier_eta: (row.carrier_eta as string | null) ?? null,
    manual_eta: (row.manual_eta as string | null) ?? null,
    carrier_status:
      (row.carrier_status as TrackingEntry["carrier_status"]) ?? "pending",
    carrier_detail: (row.carrier_detail as string | null) ?? null,
  }));
}

/**
 * Poll every distinct number once and persist the results.
 *
 * Returns the updated rows plus the call count, which is the thing worth
 * asserting on: a regression here is invisible except as a carrier bill.
 */
export async function applyEtasToNumbers(
  db: Knex,
  rows: RefreshableNumber[]
): Promise<{
  updated: RefreshableNumber[];
  changedIds: Set<string>;
  stats: FetchStats;
}> {
  // Delivered is terminal — stop re-querying once the actual delivery date is
  // captured. (A delivered row predating this behavior may still have a null
  // date, so re-fetch it once to backfill.)
  const settled = (r: RefreshableNumber): boolean =>
    r.carrier_status === "delivered" && r.carrier_eta !== null;

  // Other/manual freight still participates in Expected Delivery, but it has
  // no carrier adapter to call and Refresh must never disturb its manual ETA.
  const toPoll = rows.filter((r) => !settled(r) && isTrackable(r));
  const { byKey, stats } = await fetchUniqueEtas(toPoll);

  const now = new Date().toISOString();
  const changedIds = new Set<string>();
  const updated: RefreshableNumber[] = [];

  for (const row of rows) {
    if (settled(row)) {
      updated.push(row);
      continue;
    }
    const result = byKey.get(lookupKey(row));
    if (!result) {
      updated.push(row);
      continue;
    }

    // A transient failure ("error") or "no data yet" ("unavailable") returns a
    // null ETA. Don't let a single bad poll wipe a previously known one — keep
    // the last good value + status, record only the note and the fetch time.
    // With a daily cron, blanking would otherwise persist for up to a day.
    const softNull =
      result.estimated_delivery === null &&
      (result.status === "error" || result.status === "unavailable");

    if (softNull && row.carrier_eta !== null) {
      if (result.detail !== row.carrier_detail) changedIds.add(row.id);
      await db.raw(
        `UPDATE purchase_order_tracking_number
            SET carrier_detail = ?, carrier_eta_fetched_at = ?, updated_at = now()
          WHERE id = ?`,
        [result.detail, now, row.id]
      );
      updated.push({ ...row, carrier_detail: result.detail });
      continue;
    }

    if (
      result.estimated_delivery !== row.carrier_eta ||
      result.status !== row.carrier_status ||
      result.detail !== row.carrier_detail
    ) {
      changedIds.add(row.id);
    }

    await db.raw(
      `UPDATE purchase_order_tracking_number
          SET carrier_eta = ?, carrier_status = ?, carrier_detail = ?,
              carrier_eta_fetched_at = ?, updated_at = now()
        WHERE id = ?`,
      [result.estimated_delivery, result.status, result.detail, now, row.id]
    );

    updated.push({
      ...row,
      carrier_eta: result.estimated_delivery,
      carrier_status: result.status,
      carrier_detail: result.detail,
    });
  }

  return { updated, changedIds, stats };
}

/**
 * Settle one PO's `expected_at` from numbers that were ALREADY refreshed.
 *
 * Split from the polling so the cron can poll the whole run once and then
 * settle each PO — the header is per-PO, the carrier call is not.
 */
export async function settleExpectedAt(
  service: PoServiceLike,
  po: PoLike,
  numbers: RefreshableNumber[],
  forceApply = false
): Promise<{ expected_at: string | null; changed: boolean }> {
  // Earliest upcoming ETA drives Expected Delivery while anything is still in
  // transit. If nothing is upcoming but the shipment was delivered, use the
  // ACTUAL delivery date (latest, when several packages) so the date reflects
  // reality instead of a stale future estimate.
  const effectiveNumbers = numbers.map((number) => ({
    ...number,
    carrier_eta: effectiveTrackingEta(number),
  }));
  let selected = selectExpectedEta(
    effectiveNumbers as unknown as TrackingEntry[]
  );
  if (!selected) {
    const deliveredDates = numbers
      .filter((n) => n.carrier_status === "delivered")
      .map((n) => n.carrier_eta)
      .filter((d): d is string => Boolean(d) && ISO_DATE.test(d as string))
      .sort();
    if (deliveredDates.length > 0) {
      selected = deliveredDates[deliveredDates.length - 1] ?? null;
    }
  }

  const currentExpected =
    po.expected_at === null || po.expected_at === ""
      ? null
      : new Date(po.expected_at as string | Date).toISOString().slice(0, 10);

  const expectedAtOut: string | null =
    currentExpected === null
      ? null
      : new Date(po.expected_at as string | Date).toISOString();

  // Policy (product decision 2026-07-02, UNCHANGED by the move to shipments):
  // the carrier ETA always drives Expected Delivery when known, overwriting any
  // prior value; a manual date is only a fallback used while the carrier has no
  // ETA. forceApply just forces an idempotent re-write from the explicit
  // "Apply" action.
  if (selected && (selected !== currentExpected || forceApply)) {
    const expectedAt = new Date(`${selected}T00:00:00.000Z`);
    await service.updatePurchaseOrders([
      { id: po.id, expected_at: expectedAt },
    ]);
    return { expected_at: expectedAt.toISOString(), changed: true };
  }

  return { expected_at: expectedAtOut, changed: false };
}

/** Refresh one PO end to end — the on-demand path. */
export async function refreshPoTrackingEta(
  db: Knex,
  service: PoServiceLike,
  po: PoLike,
  forceApply = false
): Promise<RefreshResult> {
  const rows = await loadRefreshableNumbers(db, po.id);
  if (rows.length === 0) {
    return { tracking: [], expected_at: null, changed: false };
  }

  const { updated, changedIds } = await applyEtasToNumbers(db, rows);
  const header = await settleExpectedAt(service, po, updated, forceApply);

  return {
    tracking: updated,
    expected_at: header.expected_at,
    changed: changedIds.size > 0 || header.changed,
  };
}
