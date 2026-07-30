/**
 * One-off: refresh carrier ETAs for all open POs right now (same routine as the
 * daily cron), so we can watch Expected Delivery populate after a carrier
 * credential fix. Writes purchase_order_tracking + expected_at.
 *
 * Run with FEDEX_CLIENT_ID/SECRET exported:
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env|cut -d= -f2-)" \
 *     npx medusa exec ./src/scripts/debug/refresh-po-tracking-now.ts
 */

import { PURCHASE_ORDERS_MODULE } from "../../modules/purchase-orders";
import { isTrackable } from "../../lib/carrier-tracking";
import { refreshPoTrackingEta } from "../../lib/carrier-tracking/refresh-po";

interface CandidateRow {
  id: string;
  number: string | null;
  expected_at: Date | string | null;
  provider: string;
  tracking_number: string;
}

interface PoServiceLike {
  updatePurchaseOrders: (d: Record<string, unknown>[]) => Promise<unknown>;
}

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

export default async function run({
  container,
}: {
  container: { resolve: (k: string) => unknown };
}): Promise<void> {
  const service = container.resolve(PURCHASE_ORDERS_MODULE) as PoServiceLike;
  const db = container.resolve("__pg_connection__") as Knex;

  const result = await db.raw(
    `SELECT DISTINCT po.id, po.number, po.expected_at,
            n.provider, n.tracking_number
       FROM purchase_order po
       JOIN purchase_order_tracking trk
         ON trk.purchase_order_id = po.id AND trk.deleted_at IS NULL
       JOIN purchase_order_tracking_number n
         ON n.purchase_order_tracking_id = trk.id AND n.deleted_at IS NULL
      WHERE po.deleted_at IS NULL
        AND po.status IN ('submitted', 'partially_received')
        AND (n.carrier_status <> 'delivered' OR n.carrier_eta IS NULL)
      ORDER BY po.id`
  );

  // One entry per PO — refreshPoTrackingEta handles the whole PO in one pass.
  const byPo = new Map<string, CandidateRow>();
  for (const row of result.rows as CandidateRow[]) {
    if (!isTrackable(row)) continue;
    if (!byPo.has(row.id)) byPo.set(row.id, row);
  }
  const targets = [...byPo.values()];

  process.stdout.write(
    `\n[refresh-now] ${targets.length} open PO(s) with trackable shipments\n\n`
  );

  for (const po of targets) {
    const before =
      po.expected_at == null
        ? "—"
        : new Date(po.expected_at as string | Date).toISOString().slice(0, 10);
    try {
      const res = await refreshPoTrackingEta(db, service, {
        id: po.id,
        expected_at: po.expected_at,
      });
      const after = res.expected_at ? res.expected_at.slice(0, 10) : "—";
      const detail = res.tracking
        .map((t) => `${t.provider}:${t.carrier_status}:${t.carrier_eta ?? "—"}`)
        .join(" | ");
      const flag = before !== after ? "  <== UPDATED" : "";
      process.stdout.write(
        `${(po.number ?? po.id).padEnd(10)} expected ${before} -> ${after}  [${detail}]${flag}\n`
      );
    } catch (e) {
      process.stdout.write(
        `${po.number ?? po.id}  ERROR: ${(e as Error).message}\n`
      );
    }
  }
  process.stdout.write("\n[refresh-now] done\n");
}
