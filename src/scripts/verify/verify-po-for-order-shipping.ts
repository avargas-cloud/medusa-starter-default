/**
 * verify-po-for-order-shipping
 *
 * Gate for the Product Status modal's per-LINE shipping (In Transit + Tracking).
 *
 * WHAT IT PROVES
 *
 * 1. On the real case that exposed the bug (S11581 / PO-1160, present in the
 *    sandbox snapshot): the fan line — never placed on a shipment — carries NO
 *    tracking and 0 in transit, while the PO-level list still names the UPS
 *    number (the toolbar badge keeps reading it). Before 2026-09-14 the modal
 *    quoted the fan the lamp's waybill and its "delivered Sep 3".
 *
 * 2. On a synthetic PO built INSIDE A TRANSACTION THAT IS ROLLED BACK (nothing
 *    persists, any DB — but run it on the sandbox anyway):
 *      - a `by_line` shipment X with 2 of line A (5 ordered) → A: shipped 2,
 *        in_transit 2, tracking [X]; line B on the same PO sees nothing;
 *      - receiving those 2 → A: in_transit 0, tracking [] (X is gone);
 *      - a second shipment Y with 3 more of A → A: in_transit 3, tracking [Y]
 *        and NOT X — a landed waybill never resurfaces.
 *
 * WHAT IT CANNOT PROVE
 * That the screen renders the column — that is `store-pos/scripts/checks/
 * product-status-rows.mts` (pure rows) plus the visual check. And it goes
 * through `loadPosForOrder` on purpose, never `lineShippingOf` alone: the
 * defect was in the DTO the route hands out, so that is the surface asserted.
 *
 * Run (READ-ONLY effect — the synthetic part is rolled back):
 *   env DATABASE_URL="postgres://postgres:sandbox@localhost:5499/medusa" \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-po-for-order-shipping.ts
 */
import { Client, type Pool } from "pg";

import { loadPosForOrder } from "../../api/admin/purchase-orders/for-order/_lib/po-for-order-query";

let failures = 0;
const assert = (ok: boolean, label: string, detail = ""): void => {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const REAL_ORDER = "order_01M0FX8CPBY9X9AYBSZMRJ6MB3"; // S11581
const REAL_PO = "PO-1160";
const FAN = "MAX-88755WTBKWN";
const LAMP = "MAX-28712CRGL";

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
  const knex = {
    raw: async (sql: string, bindings?: unknown[]) => {
      let i = 0;
      return client.query(sql.replace(/\?/g, () => `$${++i}`), bindings as unknown[]);
    },
  };
  // Same connection for both handles so the uncommitted synthetic rows are
  // visible to every read of the transaction.
  const pool = client as unknown as Pool;

  try {
    // ── 1. The real case ──────────────────────────────────────────────────
    console.log(`\n── ${REAL_PO} on S11581 (snapshot data) ──`);
    const real = (await loadPosForOrder(pool, REAL_ORDER, knex)).find(
      (p) => p.number === REAL_PO
    );
    if (!real) {
      console.log(`⚠️  ${REAL_PO} not linked to S11581 in this DB — skipping the real case`);
    } else {
      const fan = real.lines.find((l) => l.sku === FAN);
      const lamp = real.lines.find((l) => l.sku === LAMP);
      assert(real.tracking.length >= 1, "PO-level list still names the UPS number (badge)");
      assert(!!fan && fan.tracking.length === 0, "fan line: NO tracking", JSON.stringify(fan?.tracking));
      assert(!!fan && fan.in_transit === 0 && fan.shipped === 0, "fan line: shipped 0 / in transit 0");
      assert(!!lamp && lamp.shipped === 1 && lamp.in_transit === 0, "lamp line: shipped 1, received → in transit 0");
      assert(!!lamp && lamp.tracking.length === 0, "lamp line: landed waybill dropped off the line");
    }

    // ── 2. Synthetic, rolled back ─────────────────────────────────────────
    console.log("\n── synthetic PO (transaction, rolled back) ──");
    await client.query("BEGIN");
    const tag = `verify_${Date.now().toString(36)}`;
    const orderId = `order_${tag}`;
    const poId = `po_${tag}`;
    const lineA = `pol_${tag}_a`;
    const lineB = `pol_${tag}_b`;

    await client.query(
      `INSERT INTO purchase_order (id, number, status, vendor_id, stock_location_id,
              created_by_user_id, linked_order_ids, expected_at)
       VALUES ($1, $2, 'submitted', 'vendor_verify', 'sloc_verify', 'user_verify', $3, '2026-12-31')`,
      [poId, `PO-${tag}`, JSON.stringify([orderId])]
    );
    await client.query(
      `INSERT INTO purchase_order_line (id, purchase_order_id, product_variant_id, inventory_item_id,
              sku_snapshot, description_snapshot, qty_ordered, unit_cost_cents, total_cents, line_order)
       VALUES ($1, $2, 'variant_a', 'iitem_a', 'VERIFY-A', 'A', 5, 100, 500, 0),
              ($3, $2, 'variant_b', 'iitem_b', 'VERIFY-B', 'B', 3, 100, 300, 1)`,
      [lineA, poId, lineB]
    );

    const shipment = async (id: string, number: string, qty: number, status: string): Promise<void> => {
      await client.query(
        `INSERT INTO purchase_order_tracking (id, purchase_order_id, scope) VALUES ($1, $2, 'by_line')`,
        [id, poId]
      );
      await client.query(
        `INSERT INTO purchase_order_tracking_number (id, purchase_order_tracking_id, purchase_order_id,
                provider, tracking_number, tracking_url, is_master, carrier_status, carrier_eta)
         VALUES ($1, $2, $3, 'UPS', $4, '', true, $5, '2026-12-20')`,
        [`${id}_n`, id, poId, number, status]
      );
      await client.query(
        `INSERT INTO purchase_order_tracking_line (id, purchase_order_tracking_id, purchase_order_line_id,
                purchase_order_id, qty_allocated)
         VALUES ($1, $2, $3, $4, $5)`,
        [`${id}_l`, id, lineA, poId, qty]
      );
    };

    const read = async () => {
      const po = (await loadPosForOrder(pool, orderId, knex)).find((p) => p.id === poId);
      if (!po) throw new Error("synthetic PO not returned");
      const a = po.lines.find((l) => l.id === lineA)!;
      const b = po.lines.find((l) => l.id === lineB)!;
      return { po, a, b };
    };
    const numbers = (l: { tracking: { tracking_number: string }[] }) =>
      l.tracking.map((t) => t.tracking_number).join(",");

    // Step 1: X carries 2 of A.
    await shipment(`potrk_${tag}_x`, "X", 2, "in_transit");
    let s = await read();
    assert(s.a.shipped === 2 && s.a.in_transit === 2, "X shipped: A shipped 2 / in transit 2", `${s.a.shipped}/${s.a.in_transit}`);
    assert(numbers(s.a) === "X", "X shipped: A tracking [X]", numbers(s.a));
    assert(s.b.shipped === 0 && s.b.in_transit === 0 && s.b.tracking.length === 0, "X shipped: B sees nothing (by_line)");
    assert(s.po.tracking.length === 1, "X shipped: PO-level list has 1 number");

    // Step 2: those 2 are received.
    await client.query(`UPDATE purchase_order_line SET qty_received = 2 WHERE id = $1`, [lineA]);
    s = await read();
    assert(s.a.shipped === 2 && s.a.in_transit === 0, "received 2: A shipped 2 / in transit 0", `${s.a.shipped}/${s.a.in_transit}`);
    assert(s.a.tracking.length === 0, "received 2: X is gone from A", numbers(s.a));
    assert(s.po.tracking.length === 1, "received 2: PO-level list STILL has X (badge)");

    // Step 3: Y carries 3 more of A.
    await shipment(`potrk_${tag}_y`, "Y", 3, "in_transit");
    s = await read();
    assert(s.a.shipped === 5 && s.a.in_transit === 3, "Y shipped: A shipped 5 / in transit 3", `${s.a.shipped}/${s.a.in_transit}`);
    assert(numbers(s.a) === "Y", "Y shipped: A tracking [Y], never X again", numbers(s.a));

    await client.query("ROLLBACK");
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM purchase_order WHERE id = $1`, [poId]);
    assert(rows[0].n === 0, "rolled back: synthetic PO does not exist");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }

  console.log(failures ? `\n❌ ${failures} failure(s)` : "\n✅ all checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
