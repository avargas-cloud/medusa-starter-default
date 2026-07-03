/**
 * Backfill: stamp `po_status = "Fully Received"` on every purchase order that is
 * already fully received. "Fully received" == lifecycle `status = 'received'`
 * (Medusa flips a PO to `received` exactly when qty_received >= qty_ordered on
 * all lines), which is the canonical fully-received marker.
 *
 * This aligns historical POs with the runtime rule now stamped by the receipt
 * pipeline (persist-receipt-step + reconcileReceivedPoStatus). It overrides any
 * stale prior tag (e.g. "Shipped (Waiting on Arrival)") because the goods have
 * arrived in full — matching how a fresh full receipt behaves. Terminal POs
 * (closed / cancelled / voided) are NOT lifecycle `received`, so they are never
 * touched.
 *
 * Dry-run by default (prints what it WOULD change). Apply with DRY_RUN=false:
 *   cd backend
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env|cut -d= -f2-) \
 *     npx medusa exec ./src/scripts/fix/backfill-fully-received-po-status.ts          # dry-run
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env|cut -d= -f2-) DRY_RUN=false \
 *     npx medusa exec ./src/scripts/fix/backfill-fully-received-po-status.ts          # apply
 *
 * Idempotent: POs already tagged "Fully Received" are skipped.
 */

import { PURCHASE_ORDERS_MODULE } from "../../modules/purchase-orders";
import { PO_STATUS_FULLY_RECEIVED } from "../../lib/purchase-orders/po-received-status";

interface PoRow {
  id: string;
  number?: string | null;
  status: string;
  po_status: string | null;
  total_units_ordered?: number;
  total_units_received?: number;
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

  // Only fully-received POs. `status='received'` is set by the receipt pipeline
  // when every line is complete — the authoritative fully-received signal.
  const rows = await service.listPurchaseOrders(
    { status: "received" },
    { take: 10000, skip: 0 }
  );

  let changed = 0;
  let alreadyOk = 0;

  console.log(
    `Scanning ${rows.length} fully-received PO(s) (lifecycle status='received')…\n`
  );

  for (const po of rows) {
    if (po.po_status === PO_STATUS_FULLY_RECEIVED) {
      alreadyOk++;
      continue;
    }

    const label = (po.number ?? po.id).padEnd(10);
    const recv = po.total_units_received ?? "?";
    const ord = po.total_units_ordered ?? "?";
    console.log(
      `${label} "${po.po_status ?? "(none)"}" -> "${PO_STATUS_FULLY_RECEIVED}"  (received ${recv}/${ord})`
    );
    changed++;

    if (!dry) {
      await service.updatePurchaseOrders([
        { id: po.id, po_status: PO_STATUS_FULLY_RECEIVED },
      ]);
    }
  }

  console.log(
    `\n${dry ? "[DRY-RUN] would stamp" : "stamped"} ${changed} PO(s) as "${PO_STATUS_FULLY_RECEIVED}". ` +
      `${alreadyOk} already correct.\n` +
      (dry ? "Re-run with DRY_RUN=false to apply.\n" : "Done.\n")
  );
}
