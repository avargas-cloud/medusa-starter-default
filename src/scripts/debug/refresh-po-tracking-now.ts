/**
 * One-off: refresh carrier ETAs for all open POs right now (same routine as the
 * daily cron), so we can watch Expected Delivery populate after the UPS/FedEx
 * credential fix. Read-mostly: only writes purchase_order.tracking + expected_at
 * via the module service. Run with FEDEX_CLIENT_ID/SECRET exported.
 */

import { PURCHASE_ORDERS_MODULE } from "../../modules/purchase-orders";
import { isTrackable } from "../../lib/carrier-tracking";
import { refreshPoTrackingEta } from "../../lib/carrier-tracking/refresh-po";
import type { TrackingEntry } from "../../lib/carrier-tracking/types";

interface PoRow {
  id: string;
  number?: string | null;
  expected_at: Date | string | null;
  tracking: TrackingEntry[] | null;
}

interface PoServiceLike {
  listPurchaseOrders: (
    filter: Record<string, unknown>,
    config: Record<string, unknown>
  ) => Promise<PoRow[]>;
  updatePurchaseOrders: (d: Record<string, unknown>[]) => Promise<unknown>;
}

export default async function run({
  container,
}: {
  container: { resolve: (k: string) => unknown };
}): Promise<void> {
  const service = container.resolve(PURCHASE_ORDERS_MODULE) as PoServiceLike;

  const rows = await service.listPurchaseOrders(
    { status: ["submitted", "partially_received"] },
    { take: 1000, skip: 0 }
  );

  const targets = rows.filter((po) => {
    const entries = Array.isArray(po.tracking) ? po.tracking : [];
    return entries.some(
      (e) =>
        isTrackable(e) &&
        (e.carrier_status !== "delivered" || e.carrier_eta === null)
    );
  });

  console.log(`\n[refresh-now] ${targets.length} open PO(s) with trackable shipments\n`);

  for (const po of targets) {
    const before =
      po.expected_at == null
        ? "—"
        : new Date(po.expected_at as string | Date).toISOString().slice(0, 10);
    try {
      const res = await refreshPoTrackingEta(service, po);
      const after = res.expected_at ? res.expected_at.slice(0, 10) : "—";
      const detail = res.tracking
        .map((t) => `${t.provider}:${t.carrier_status}:${t.carrier_eta ?? "—"}`)
        .join(" | ");
      const flag = before !== after ? "  <== UPDATED" : "";
      console.log(
        `${(po.number ?? po.id).padEnd(10)} expected ${before} -> ${after}  [${detail}]${flag}`
      );
    } catch (e) {
      console.log(`${po.number ?? po.id}  ERROR: ${(e as Error).message}`);
    }
  }
  console.log("\n[refresh-now] done\n");
}
