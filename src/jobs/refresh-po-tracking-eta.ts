/**
 * refresh-po-tracking-eta — runs once a day at 07:00.
 *
 * Re-fetches carrier ETAs for in-transit Purchase Orders so Expected Delivery
 * stays current as packages move. Only touches POs still awaiting goods at the
 * AP level (submitted / partially_received) that carry at least one trackable,
 * non-delivered tracking entry. Failures on one PO never block the rest. The
 * POS tracking modal also refreshes on demand for immediate updates.
 */

import type { MedusaContainer } from "@medusajs/framework/types";

import { PURCHASE_ORDERS_MODULE } from "../modules/purchase-orders";
import type PurchaseOrdersModuleService from "../modules/purchase-orders/service";
import { isTrackable } from "../lib/carrier-tracking";
import { refreshPoTrackingEta } from "../lib/carrier-tracking/refresh-po";
import type { TrackingEntry } from "../lib/carrier-tracking/types";

export const config = {
  name: "refresh-po-tracking-eta",
  // Once a day at 07:00. ETAs for inbound POs don't move minute-to-minute, so
  // daily is enough and stays well within carrier rate limits (DHL = 250/day).
  schedule: "0 7 * * *",
};

// Stop polling a tracking entry this many days after it was added. Bounds the
// work so a package the carrier stopped updating (or a never-received PO) does
// not get queried forever.
const MAX_TRACKING_AGE_DAYS = 45;

interface PoRow {
  id: string;
  expected_at: Date | string | null;
  tracking: TrackingEntry[] | null;
}

function withinCutoff(createdAt: string | undefined): boolean {
  if (!createdAt) return true;
  const ageMs = Date.now() - new Date(createdAt).getTime();
  return ageMs < MAX_TRACKING_AGE_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * A PO needs refreshing if it has a trackable entry that is not yet delivered
 * and was added within the polling window. Delivered entries, untrackable
 * carriers (freight / Other / USPS), and stale entries are skipped — so a PO
 * naturally drops out of the refresh set and is never polled indefinitely.
 */
function needsRefresh(po: PoRow): boolean {
  const entries = Array.isArray(po.tracking) ? po.tracking : [];
  return entries.some(
    (e) =>
      e.carrier_status !== "delivered" &&
      isTrackable(e) &&
      withinCutoff(e.created_at)
  );
}

export default async function refreshPoTrackingEtaJob(
  container: MedusaContainer
) {
  const logger = console;
  const service = container.resolve(
    PURCHASE_ORDERS_MODULE
  ) as unknown as PurchaseOrdersModuleService;

  // Only POs still awaiting goods. A fully 'received' PO is in hand → its
  // carrier ETA is moot, so we stop refreshing it.
  const rows = (await service.listPurchaseOrders(
    { status: ["submitted", "partially_received"] },
    { take: 1000, skip: 0 }
  )) as unknown as PoRow[];

  const targets = rows.filter(needsRefresh);
  logger.info(
    `[po-tracking-eta] ${targets.length} PO(s) with in-transit tracking to refresh`
  );

  let refreshed = 0;
  let errors = 0;
  for (const po of targets) {
    try {
      const result = await refreshPoTrackingEta(
        service as unknown as {
          updatePurchaseOrders: (
            d: Record<string, unknown>[]
          ) => Promise<unknown>;
        },
        po
      );
      if (result.changed) refreshed++;
    } catch (e) {
      errors++;
      logger.error(
        `[po-tracking-eta] PO ${po.id} refresh failed: ${(e as Error).message}`
      );
    }
  }

  logger.info(
    `[po-tracking-eta] ✓ done — ${refreshed} updated, ${errors} errors`
  );
}
