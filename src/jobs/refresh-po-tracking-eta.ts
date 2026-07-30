/**
 * refresh-po-tracking-eta — runs once a day at 07:00.
 *
 * Re-fetches carrier ETAs for in-transit Purchase Orders so Expected Delivery
 * stays current as packages move. Only touches POs still awaiting goods at the
 * AP level (submitted / partially_received) that carry at least one trackable,
 * non-delivered tracking number.
 *
 * ONE CARRIER CALL PER NUMBER, ACROSS THE WHOLE RUN. The candidates are loaded
 * for every PO first and polled together, so a waybill naming deliveries on
 * three purchase orders is asked about ONCE, not three times. Doing it PO by PO
 * — the obvious shape — silently multiplies the carrier bill by however often
 * a vendor consolidates orders onto one truck, and nothing in the output would
 * have shown it. The run logs its call count for exactly that reason.
 *
 * Expected Delivery is then settled per PO, because the header is per PO even
 * though the carrier lookup is not. A failure on one PO never blocks the rest.
 */

import type { MedusaContainer } from "@medusajs/framework/types";

import { PURCHASE_ORDERS_MODULE } from "../modules/purchase-orders";
import type PurchaseOrdersModuleService from "../modules/purchase-orders/service";
import { isTrackable } from "../lib/carrier-tracking";
import {
  applyEtasToNumbers,
  settleExpectedAt,
  type RefreshableNumber,
} from "../lib/carrier-tracking/refresh-po";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";
export const config = {
  name: "refresh-po-tracking-eta",
  // Once a day at 07:00. ETAs for inbound POs don't move minute-to-minute, so
  // daily is enough and stays well within carrier rate limits (DHL = 250/day).
  schedule: "0 7 * * *",
};

// Stop polling a tracking number this many days after it was added. Bounds the
// work so a package the carrier stopped updating (or a never-received PO) does
// not get queried forever.
const MAX_TRACKING_AGE_DAYS = 45;

interface CandidateRow extends RefreshableNumber {
  expected_at: Date | string | null;
}

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

export default async function refreshPoTrackingEtaJob(
  container: MedusaContainer
) {
  if (isScheduledJobsDisabled(container)) return;

  const logger = console;
  const service = container.resolve(
    PURCHASE_ORDERS_MODULE
  ) as unknown as PurchaseOrdersModuleService;
  const db = container.resolve("__pg_connection__") as unknown as Knex;

  // Only POs still awaiting goods — a fully 'received' PO is in hand, so its
  // carrier ETA is moot. Delivered numbers (with their actual date already
  // captured) and numbers past the age cutoff drop out here, so a PO leaves the
  // refresh set on its own and is never polled indefinitely.
  const result = await db.raw(
    `SELECT n.id, n.purchase_order_id, n.provider, n.tracking_number,
            n.carrier_eta, n.carrier_status, n.carrier_detail,
            po.expected_at
       FROM purchase_order_tracking_number n
       JOIN purchase_order_tracking trk
         ON trk.id = n.purchase_order_tracking_id AND trk.deleted_at IS NULL
       JOIN purchase_order po
         ON po.id = n.purchase_order_id AND po.deleted_at IS NULL
      WHERE n.deleted_at IS NULL
        AND po.status IN ('submitted', 'partially_received')
        AND n.created_at > now() - make_interval(days => ?)
        AND (n.carrier_status <> 'delivered' OR n.carrier_eta IS NULL)
      ORDER BY n.purchase_order_id, n.created_at, n.id`,
    [MAX_TRACKING_AGE_DAYS]
  );

  // Carrier detection lives in code (provider aliases, number-shape
  // auto-detect), so the trackable check cannot be SQL.
  const candidates = (result.rows as CandidateRow[]).filter((r) =>
    isTrackable(r)
  );

  if (candidates.length === 0) {
    logger.info("[po-tracking-eta] nothing in transit to refresh");
    return;
  }

  const poIds = new Set(candidates.map((c) => c.purchase_order_id));
  logger.info(
    `[po-tracking-eta] ${candidates.length} tracking number(s) across ${poIds.size} PO(s)`
  );

  // ── The one place the carrier is called ──────────────────────────────────
  const { updated, changedIds, stats } = await applyEtasToNumbers(
    db,
    candidates
  );
  logger.info(
    `[po-tracking-eta] ${stats.calls} carrier call(s) for ${stats.rows} row(s)` +
      (stats.rows > stats.calls
        ? ` — ${stats.rows - stats.calls} duplicate lookup(s) avoided`
        : "")
  );

  // ── Settle each PO's header from numbers already refreshed ───────────────
  const byPo = new Map<string, RefreshableNumber[]>();
  for (const row of updated) {
    const bucket = byPo.get(row.purchase_order_id) ?? [];
    bucket.push(row);
    byPo.set(row.purchase_order_id, bucket);
  }
  const expectedByPo = new Map(
    candidates.map((c) => [c.purchase_order_id, c.expected_at])
  );

  let refreshed = 0;
  let errors = 0;
  for (const [poId, numbers] of byPo) {
    try {
      const header = await settleExpectedAt(service, {
        id: poId,
        expected_at: expectedByPo.get(poId) ?? null,
      }, numbers);
      const moved = numbers.some((n) => changedIds.has(n.id));
      if (header.changed || moved) refreshed++;
    } catch (e) {
      errors++;
      logger.error(
        `[po-tracking-eta] PO ${poId} settle failed: ${(e as Error).message}`
      );
    }
  }

  logger.info(
    `[po-tracking-eta] ✓ done — ${refreshed} PO(s) updated, ${errors} error(s)`
  );
}
