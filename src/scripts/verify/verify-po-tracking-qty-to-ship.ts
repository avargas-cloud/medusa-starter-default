/**
 * verify-po-tracking-qty-to-ship
 *
 * Gate for what the PO Tracking modal OFFERS on a new delivery (`qty_to_ship`),
 * as opposed to what it CAPS (`qty_remaining`, untouched — see the header of
 * `po-tracking-allocations.ts`).
 *
 * WHAT IT PROVES, on a synthetic PO inside a transaction that is ROLLED BACK:
 *   A: 5 ordered, box X carries 2                → to_ship 3, remaining 3
 *   A: those 2 received                          → to_ship 3 (X rode them), remaining 3
 *   A: 4 received in total (2 more, no box)      → to_ship 1 — the one still missing
 *   B: 1 ordered, 1 received, never on a box     → to_ship 0, remaining 1 (cap intact)
 *   Editing X (excluded from "elsewhere")        → A remaining 5, to_ship 1: the input's
 *                                                  max keeps history, LEFT keeps honesty
 * Plus the real case in the snapshot: every received line of PO-1160 offers 0.
 *
 * Run (READ-ONLY effect — everything synthetic is rolled back):
 *   env DATABASE_URL="postgres://postgres:sandbox@localhost:5499/medusa" \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-po-tracking-qty-to-ship.ts
 */
import { Client } from "pg";

import { resolveAllocatablePoLines } from "../../lib/purchase-orders/po-tracking-allocations";

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
  const knex = {
    raw: async (sql: string, bindings?: unknown[]) => {
      let i = 0;
      return client.query(sql.replace(/\?/g, () => `$${++i}`), bindings as unknown[]);
    },
  };

  try {
    console.log("\n── PO-1160 (snapshot data) ──");
    const { rows: real } = await client.query<{ id: string }>(
      `SELECT id FROM purchase_order WHERE number = 'PO-1160' AND deleted_at IS NULL`
    );
    if (!real[0]) console.log("⚠️  PO-1160 not in this DB — skipping");
    else {
      const lines = await resolveAllocatablePoLines(knex, real[0].id, null);
      const received = lines.filter((l) => l.qty_received >= l.qty_ordered);
      assert(received.length >= 6, "PO-1160: ≥6 fully received lines", String(received.length));
      assert(received.every((l) => l.qty_to_ship === 0), "PO-1160: every received line offers 0");
      const fan = lines.find((l) => l.sku_snapshot === "MAX-88755WTBKWN");
      assert(!!fan && fan.qty_to_ship === 2, "PO-1160: the fan still offers 2", String(fan?.qty_to_ship));
      assert(lines.every((l) => l.qty_to_ship <= l.qty_remaining), "PO-1160: to_ship never above the cap");
    }

    console.log("\n── synthetic PO (transaction, rolled back) ──");
    await client.query("BEGIN");
    const tag = `verify_${Date.now().toString(36)}`;
    const poId = `po_${tag}`;
    const lineA = `pol_${tag}_a`;
    const lineB = `pol_${tag}_b`;
    const boxX = `potrk_${tag}_x`;
    await client.query(
      `INSERT INTO purchase_order (id, number, status, vendor_id, stock_location_id, created_by_user_id)
       VALUES ($1, $2, 'submitted', 'vendor_verify', 'sloc_verify', 'user_verify')`,
      [poId, `PO-${tag}`]
    );
    await client.query(
      `INSERT INTO purchase_order_line (id, purchase_order_id, product_variant_id, inventory_item_id,
              sku_snapshot, description_snapshot, qty_ordered, qty_received, unit_cost_cents, total_cents, line_order)
       VALUES ($1, $2, 'variant_a', 'iitem_a', 'VERIFY-A', 'A', 5, 0, 100, 500, 0),
              ($3, $2, 'variant_b', 'iitem_b', 'VERIFY-B', 'B', 1, 1, 100, 100, 1)`,
      [lineA, poId, lineB]
    );
    await client.query(
      `INSERT INTO purchase_order_tracking (id, purchase_order_id, scope) VALUES ($1, $2, 'by_line')`,
      [boxX, poId]
    );
    await client.query(
      `INSERT INTO purchase_order_tracking_line (id, purchase_order_tracking_id, purchase_order_line_id, purchase_order_id, qty_allocated)
       VALUES ($1, $2, $3, $4, 2)`,
      [`${boxX}_l`, boxX, lineA, poId]
    );

    const read = async (exclude: string | null = null) => {
      const lines = await resolveAllocatablePoLines(knex, poId, exclude);
      const a = lines.find((l) => l.purchase_order_line_id === lineA)!;
      const b = lines.find((l) => l.purchase_order_line_id === lineB)!;
      return { a, b };
    };
    const fmt = (l: { qty_to_ship: number; qty_remaining: number }) => `to_ship ${l.qty_to_ship} / remaining ${l.qty_remaining}`;

    let s = await read();
    assert(s.a.qty_to_ship === 3 && s.a.qty_remaining === 3, "A: X carries 2 → to_ship 3, remaining 3", fmt(s.a));
    assert(s.b.qty_to_ship === 0 && s.b.qty_remaining === 1, "B: received off-record → to_ship 0, cap stays 1", fmt(s.b));

    await client.query(`UPDATE purchase_order_line SET qty_received = 2 WHERE id = $1`, [lineA]);
    s = await read();
    assert(s.a.qty_to_ship === 3 && s.a.qty_remaining === 3, "A: X's 2 received → to_ship still 3", fmt(s.a));

    await client.query(`UPDATE purchase_order_line SET qty_received = 4 WHERE id = $1`, [lineA]);
    s = await read();
    assert(s.a.qty_to_ship === 1 && s.a.qty_remaining === 3, "A: 4 received (2 off-record) → to_ship 1, cap 3", fmt(s.a));

    s = await read(boxX);
    assert(s.a.qty_to_ship === 1 && s.a.qty_remaining === 5, "A editing X: remaining 5 (history), to_ship 1", fmt(s.a));

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
