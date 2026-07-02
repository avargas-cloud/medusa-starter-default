/**
 * Backfill: keep a shipped PO's `po_status` consistent with whether it has a
 * tracking number. A PO in "Shipped (Waiting on Arrival)" with NO tracking is
 * relabeled "Shipped (Missing Tracking)" (and the reverse drift is fixed too).
 * Only touches POs already in a shipped state whose lifecycle isn't terminal.
 *
 * Dry-run by default. Apply with DRY_RUN=false.
 *   env DATABASE_URL=... DRY_RUN=false npx medusa exec ./src/scripts/fix/reconcile-shipped-po-status-tracking.ts
 */

import { PURCHASE_ORDERS_MODULE } from "../../modules/purchase-orders";
import { reconcileShippedPoStatus } from "../../api/admin/purchase-orders/_lib/po-shipping-status";
import type { TrackingEntry } from "../../lib/carrier-tracking/types";

interface PoRow {
  id: string;
  number?: string | null;
  status: string;
  po_status: string | null;
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
  const dry = process.env.DRY_RUN !== "false"; // default = dry-run
  const service = container.resolve(PURCHASE_ORDERS_MODULE) as PoServiceLike;

  const rows = await service.listPurchaseOrders({}, { take: 5000, skip: 0 });

  let changed = 0;
  for (const po of rows) {
    const entries = Array.isArray(po.tracking) ? po.tracking : [];
    const reconciled = reconcileShippedPoStatus(
      po.po_status,
      po.status,
      entries.length > 0
    );
    if (!reconciled) continue;

    console.log(
      `${(po.number ?? po.id).padEnd(10)} "${po.po_status}" -> "${reconciled}"  (tracking=${entries.length}, lifecycle=${po.status})`
    );
    changed++;
    if (!dry) {
      await service.updatePurchaseOrders([
        { id: po.id, po_status: reconciled },
      ]);
    }
  }

  console.log(
    `\n${dry ? "[DRY-RUN] would relabel" : "relabeled"} ${changed} PO(s). ${
      dry ? "Re-run with DRY_RUN=false to apply." : "Done."
    }\n`
  );
}
