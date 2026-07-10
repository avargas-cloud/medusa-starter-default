/**
 * SANDBOX-ONLY isolation test for consumeReservationsForFulfillment
 * (the shared proportional consume used by create-fulfillment-force Strategy 2
 * and the complete-pickup fallback).
 *
 * Asserts on a real sandbox order line with an active Miami reservation:
 *   1. Partial consume (qty 1): reservation DECREMENTED (survives), stock −1,
 *      reserved cache −1, raw_stocked in sync.
 *   2. Consume the remainder: reservation DELETED, stock/reserved follow.
 *
 * Usage (sandbox env vars required — NEVER prod):
 *   env DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *       REDIS_URL=redis://localhost:6399 \
 *       npx medusa exec ./src/scripts/tests/test-consume-reservations-helper.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";
import { consumeReservationsForFulfillment } from "../../api/admin/orders/[id]/_lib/consume-reservations-for-fulfillment";
import { USA_LOC } from "../../lib/locations";

export default async function testConsumeReservationsHelper({
  container,
}: ExecArgs) {
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!dbUrl.includes("5499")) {
    console.error("❌ Refusing to run: DATABASE_URL is not the sandbox (5499)");
    return;
  }

  const pg = container.resolve("__pg_connection__") as any;
  const inventoryModule = container.resolve(Modules.INVENTORY) as any;
  // knex.raw uses `?` bindings; adapt to the helper's $1-style pool interface.
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      const converted = sql.replace(/\$(\d+)/g, "?");
      const r = await pg.raw(converted, params ?? []);
      return { rows: r.rows };
    },
  };

  const { rows: cand } = await pg.raw(
    `SELECT ri.id AS res_id, ri.quantity AS res_qty, ri.line_item_id,
            ri.inventory_item_id, il.stocked_quantity, il.reserved_quantity,
            (il.raw_stocked_quantity->>'value')::numeric AS raw_stocked
       FROM reservation_item ri
       JOIN inventory_level il
         ON il.inventory_item_id = ri.inventory_item_id
        AND il.location_id = ? AND il.deleted_at IS NULL
      WHERE ri.deleted_at IS NULL AND ri.location_id = ?
        AND ri.quantity >= 3 AND ri.line_item_id IS NOT NULL
      ORDER BY ri.created_at DESC LIMIT 1`,
    [USA_LOC, USA_LOC]
  );
  if (!cand.length) {
    console.error("❌ No sandbox reservation with qty >= 3 found");
    return;
  }
  const c = cand[0];
  const resQty = Number(c.res_qty);
  const stocked0 = Number(c.stocked_quantity);
  const reserved0 = Number(c.reserved_quantity);
  console.log(
    `Target: line ${c.line_item_id} res ${c.res_id}×${resQty} · stocked ${stocked0} · reserved ${reserved0}`
  );

  const state = async () => {
    const { rows } = await pg.raw(
      `SELECT (SELECT quantity FROM reservation_item WHERE id = ? AND deleted_at IS NULL) AS res_qty,
              il.stocked_quantity, il.reserved_quantity,
              (il.raw_stocked_quantity->>'value')::numeric AS raw_stocked
         FROM inventory_level il
        WHERE il.inventory_item_id = ? AND il.location_id = ? AND il.deleted_at IS NULL`,
      [c.res_id, c.inventory_item_id, USA_LOC]
    );
    return rows[0];
  };

  let pass = true;
  const assert = (label: string, actual: unknown, expected: unknown) => {
    const ok = Number(actual) === Number(expected);
    if (!ok) pass = false;
    console.log(`  ${ok ? "✅" : "❌"} ${label}: ${actual} (expected ${expected})`);
  };

  // ── Step 1: partial consume (qty 1) — reservation must SURVIVE decremented
  console.log(`\nStep 1: consume 1 of ${resQty}`);
  await consumeReservationsForFulfillment({
    pool,
    inventoryModule,
    locationId: USA_LOC,
    items: [{ line_item_id: c.line_item_id, quantity: 1 }],
    logPrefix: "[test]",
  });
  let s = await state();
  assert("reservation qty (survives)", s.res_qty, resQty - 1);
  assert("stocked", s.stocked_quantity, stocked0 - 1);
  assert("raw_stocked (BigNumber sync)", s.raw_stocked, stocked0 - 1);
  assert("reserved cache", s.reserved_quantity, reserved0 - 1);

  // ── Step 2: consume the remainder — reservation must be DELETED
  console.log(`\nStep 2: consume remaining ${resQty - 1}`);
  await consumeReservationsForFulfillment({
    pool,
    inventoryModule,
    locationId: USA_LOC,
    items: [{ line_item_id: c.line_item_id, quantity: resQty - 1 }],
    logPrefix: "[test]",
  });
  s = await state();
  if (s.res_qty !== null) {
    pass = false;
    console.log(`  ❌ reservation still active with qty ${s.res_qty}`);
  } else {
    console.log(`  ✅ reservation deleted`);
  }
  assert("stocked", s.stocked_quantity, stocked0 - resQty);
  assert("raw_stocked (BigNumber sync)", s.raw_stocked, stocked0 - resQty);
  assert("reserved cache", s.reserved_quantity, reserved0 - resQty);

  console.log(`\n${pass ? "✅ ALL PASS" : "❌ FAILURES — see above"}`);
}
