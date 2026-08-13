/**
 * verify-inbound-by-sku
 *
 * Gate for the POS stock modal's inbound block.
 *
 * WHAT IT PROVES
 *
 * 1. `on_order` from `resolveInboundBySku` EQUALS what `/on-order` computes for
 *    the same SKU. These are two readers of one fact, and the modal shows both
 *    at once — the total on top and the rows that decompose it. If they ever
 *    disagree the screen contradicts itself, and the contradiction is silent:
 *    both numbers look plausible alone.
 *
 * 2. The invariant holds on live data:
 *
 *        on_order == Σ(deliveries[].qty) + unassigned
 *
 *    Checked per SKU, over every SKU that actually has something on order —
 *    not a sample, because the failure this catches is data-shaped and a sample
 *    would step around it.
 *
 * 3. No delivery row is emitted with a non-positive quantity. A zero-unit row
 *    reads as a shipment carrying nothing and is always a bug in the FIFO.
 *
 * WHAT IT CANNOT PROVE
 * The FIFO tie-break between SEVERAL deliveries of a PO that has ALSO received
 * part of its goods. That combination does not exist in the sandbox (PO-1119 has
 * two deliveries and no receipts; PO-1110 has 294 of 344 received across one
 * delivery). That branch is covered by
 * `src/__tests__/inbound-by-sku/fifo.unit.spec.ts` on synthetic input, and this
 * script says so out loud rather than implying coverage it does not have.
 *
 * The `/on-order` side is recomputed here straight from the tables rather than
 * by calling the route: comparing the function to itself proves nothing.
 *
 * Run (any DB — READ-ONLY, writes nothing):
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env|cut -d= -f2-)" \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-inbound-by-sku.ts
 */
import { Client } from "pg";

import { resolveInboundBySku } from "../../lib/purchase-orders/inbound-by-sku";
import {
  ACTIVE_PO_STATUSES,
  ACTIVE_PO_LINE_STATUSES,
} from "../../api/admin/purchase-orders/_lib/po-active-status";

let failures = 0;
const assert = (ok: boolean, label: string, detail = ""): void => {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  const client = new Client({
    connectionString,
    ...(/@(localhost|127\.0\.0\.1)[:/]/.test(connectionString)
      ? {}
      : { ssl: { rejectUnauthorized: false } }),
  });
  await client.connect();

  // The lib uses `?` placeholders (the `__pg_connection__` pool); pg uses `$1`.
  // Adapt rather than duplicate — the point is to exercise the real statement.
  const knex = {
    raw: async (sql: string, bindings?: unknown[]) => {
      let i = 0;
      const converted = sql.replace(/\?/g, () => `$${++i}`);
      return client.query(converted, bindings as unknown[]);
    },
  };

  try {
    // Ground truth for `/on-order`, straight from the tables.
    const { rows: truth } = await client.query<{
      sku: string;
      on_order: string;
    }>(
      `SELECT l.sku_snapshot AS sku,
              SUM(l.qty_ordered - l.qty_received - l.qty_cancelled) AS on_order
         FROM purchase_order_line l
         JOIN purchase_order po ON po.id = l.purchase_order_id
        WHERE l.deleted_at IS NULL
          AND po.deleted_at IS NULL
          AND l.sku_snapshot IS NOT NULL AND l.sku_snapshot <> ''
          AND l.status  = ANY ($1::text[])
          AND po.status = ANY ($2::text[])
          AND (l.qty_ordered - l.qty_received - l.qty_cancelled) > 0
        GROUP BY l.sku_snapshot
        ORDER BY l.sku_snapshot`,
      [[...ACTIVE_PO_LINE_STATUSES], [...ACTIVE_PO_STATUSES]]
    );

    assert(truth.length > 0, "there is on-order data to verify", `${truth.length} SKUs`);
    if (!truth.length) {
      console.log(
        "\n⚠️  Nothing on order in this database — the script proved NOTHING.\n" +
          "   Point it at a DB with open POs before treating it as a gate."
      );
      failures += 1;
      return;
    }

    let mismatched = 0;
    let broken = 0;
    let emptyRows = 0;
    let withDeliveries = 0;
    let withUnassigned = 0;

    for (const row of truth) {
      const expected = Number(row.on_order);
      const got = await resolveInboundBySku(knex, row.sku);

      if (got.on_order !== expected) {
        mismatched += 1;
        if (mismatched <= 5) {
          console.log(
            `   ✗ ${row.sku}: on_order ${got.on_order} vs ${expected} from the tables`
          );
        }
      }

      const summed = got.deliveries.reduce((acc, d) => acc + d.qty, 0);
      if (summed !== got.on_order) {
        broken += 1;
        if (broken <= 5) {
          console.log(
            `   ✗ ${row.sku}: rows sum to ${summed} but on_order is ${got.on_order}` +
              ` (in_transit ${got.in_transit}, unassigned ${got.unassigned})`
          );
        }
      }

      if (got.deliveries.some((d) => d.qty <= 0)) emptyRows += 1;
      if (got.deliveries.some((d) => d.tracking_id !== null)) withDeliveries += 1;
      if (got.deliveries.some((d) => d.tracking_id === null)) withUnassigned += 1;
    }

    assert(
      mismatched === 0,
      "on_order matches the /on-order definition for every SKU",
      `${truth.length - mismatched}/${truth.length}`
    );
    assert(
      broken === 0,
      "invariant holds: on_order == Σ delivery rows",
      `${truth.length - broken}/${truth.length}`
    );
    assert(emptyRows === 0, "no delivery row carries zero or negative units");

    // Coverage report — a gate that ran against data with no shipments at all
    // would pass while proving nothing about the interesting path.
    console.log(
      `\n   coverage: ${withDeliveries} SKUs have at least one tracked delivery, ` +
        `${withUnassigned} have un-shipped units`
    );
    assert(
      withDeliveries > 0,
      "at least one SKU exercises the tracked-delivery path",
      `${withDeliveries} SKUs`
    );

    // 4. A carrier-delivered shipment whose receipt is unposted still shows its
    //    tracking number.
    //
    //    The item receipt is the only authority on how many units arrived; the
    //    carrier's `delivered` flag only decides WHICH delivery a receipt is
    //    charged to. When the flag consumed the whole claim instead, every unit
    //    of such a line fell into the untracked bucket and the stock modal
    //    reported "No tracking yet" about a waybill that had already landed —
    //    3 POs, 24 lines, 544 units on production the day it was found.
    //
    //    Unlike the FIFO tie-break, this case DOES occur in live data, so it is
    //    checked here against real rows rather than only on synthetic input.
    const { rows: deliveredPending } = await client.query<{ sku: string }>(
      `SELECT DISTINCT l.sku_snapshot AS sku
         FROM purchase_order_line l
         JOIN purchase_order po ON po.id = l.purchase_order_id
         JOIN purchase_order_tracking trk
           ON trk.purchase_order_id = po.id AND trk.deleted_at IS NULL
         JOIN purchase_order_tracking_number n
           ON n.purchase_order_tracking_id = trk.id
          AND n.deleted_at IS NULL
          AND n.is_master
          AND n.carrier_status = 'delivered'
        WHERE l.deleted_at IS NULL
          AND po.deleted_at IS NULL
          AND l.sku_snapshot IS NOT NULL AND l.sku_snapshot <> ''
          AND l.status  = ANY ($1::text[])
          AND po.status = ANY ($2::text[])
          AND l.qty_received = 0
          AND (l.qty_ordered - l.qty_received - l.qty_cancelled) > 0
          AND (trk.scope = 'all_order'
               OR EXISTS (SELECT 1
                            FROM purchase_order_tracking_line trkl
                           WHERE trkl.purchase_order_tracking_id = trk.id
                             AND trkl.purchase_order_line_id = l.id))
        ORDER BY l.sku_snapshot`,
      [[...ACTIVE_PO_LINE_STATUSES], [...ACTIVE_PO_STATUSES]]
    );

    let lostTracking = 0;
    for (const row of deliveredPending) {
      const got = await resolveInboundBySku(knex, row.sku);
      const shown = got.deliveries.some(
        (d) => d.delivered && d.tracking_id !== null && d.qty > 0
      );
      if (!shown) {
        lostTracking += 1;
        if (lostTracking <= 5) {
          console.log(
            `   ✗ ${row.sku}: a delivered shipment is pending receipt but no` +
              ` tracked row carries it (unassigned ${got.unassigned})`
          );
        }
      }
    }

    if (deliveredPending.length === 0) {
      // Not a pass. The check is only as good as the data it ran against, and
      // saying so is the difference between coverage and the appearance of it.
      console.log(
        "\n   ⚠️  no delivered-but-unreceived shipment in this database — the" +
          " receipt-authority check proved nothing here (it is also pinned in" +
          " fifo.unit.spec.ts)"
      );
    } else {
      assert(
        lostTracking === 0,
        "a delivered shipment pending receipt keeps its tracking number",
        `${deliveredPending.length - lostTracking}/${deliveredPending.length} SKUs`
      );
    }

    console.log(
      "\n   NOT covered here: the FIFO tie-break across several deliveries of a PO\n" +
        "   with a partial receipt — no such PO exists. See fifo.unit.spec.ts."
    );
  } finally {
    await client.end();
  }

  console.log(
    failures === 0
      ? "\n✅ verify-inbound-by-sku PASSED"
      : `\n❌ verify-inbound-by-sku FAILED (${failures})`
  );
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
