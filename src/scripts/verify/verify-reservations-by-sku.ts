/**
 * verify-reservations-by-sku
 *
 * Gate for the POS stock modal's "who reserved it" list.
 *
 * WHAT IT PROVES
 *
 * 1. For EVERY SKU with reserved units in Miami (not a sample — the failure is
 *    data-shaped), the invariant holds:
 *
 *        reserved == Σ(rows[].reserved) + unattributed
 *
 * 2. `reserved` equals `inventory_level.reserved_quantity` read straight from
 *    the table: the lib and the badge must print the same number.
 *
 * 3. No row is emitted with a non-positive quantity, and no row is attributed
 *    to an order whose CURRENT version does not carry the line (the stale
 *    `order_item` versions are the trap that multiplies quantities).
 *
 * 4. Positive control of the binding: a SKU that cannot exist returns an empty
 *    list with reserved 0 and unattributed 0 — proving the parameters bind
 *    and nothing is matched by accident.
 *
 * Run (any DB — READ-ONLY, writes nothing):
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env|cut -d= -f2-)" \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-reservations-by-sku.ts
 */
import { Client } from "pg";

import { resolveReservationsBySku } from "../../lib/inventory/reservations-by-sku";
import { USA_LOC } from "../../lib/locations";

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
  const knex = {
    raw: async (sql: string, bindings?: unknown[]) => {
      let i = 0;
      const converted = sql.replace(/\?/g, () => `$${++i}`);
      return client.query(converted, bindings as unknown[]);
    },
  };

  try {
    const { rows: truth } = await client.query<{
      sku: string;
      reserved: string;
    }>(
      `SELECT ii.sku, SUM(il.reserved_quantity) AS reserved
         FROM inventory_level il
         JOIN inventory_item ii ON ii.id = il.inventory_item_id AND ii.deleted_at IS NULL
        WHERE il.deleted_at IS NULL
          AND il.location_id = $1
          AND il.reserved_quantity > 0
        GROUP BY ii.sku
        ORDER BY ii.sku`,
      [USA_LOC]
    );
    assert(
      truth.length > 0,
      "SKUs with reserved units exist",
      `${truth.length}`
    );
    if (truth.length === 0) {
      console.log(
        "   (loader empty — the invariant checks below would be vacuous)"
      );
      failures += 1;
    }

    let invariantBreaks = 0;
    let headlineBreaks = 0;
    let badRows = 0;
    let unattributedSkus = 0;
    let totalRows = 0;
    for (const t of truth) {
      const out = await resolveReservationsBySku(knex, t.sku);
      const sum = out.rows.reduce((a, r) => a + r.reserved, 0);
      if (out.reserved !== sum + out.unattributed) {
        invariantBreaks += 1;
        console.log(
          `   ✗ ${t.sku}: reserved ${out.reserved} ≠ ${sum} + ${out.unattributed}`
        );
      }
      if (out.reserved !== Number(t.reserved)) {
        headlineBreaks += 1;
        console.log(
          `   ✗ ${t.sku}: lib says ${out.reserved}, table says ${t.reserved}`
        );
      }
      if (out.unattributed !== 0) {
        unattributedSkus += 1;
        console.log(
          `   ℹ ${t.sku}: ${out.unattributed} unit(s) reserved by no live order line`
        );
      }
      totalRows += out.rows.length;
      for (const r of out.rows) {
        if (r.reserved <= 0 || !r.order_id || r.ordered < r.reserved)
          badRows += 1;
      }
    }
    assert(
      invariantBreaks === 0,
      "reserved == Σ rows + unattributed on every SKU",
      `${truth.length} SKUs`
    );
    assert(
      headlineBreaks === 0,
      "lib headline == inventory_level cache",
      `${truth.length} SKUs`
    );
    assert(
      badRows === 0,
      "every row has qty > 0, an order, and ordered ≥ reserved",
      `${totalRows} rows`
    );
    console.log(
      `   ${unattributedSkus} SKU(s) with unattributed reservations (informational)`
    );

    // Every emitted row must sit on the order's CURRENT version.
    const { rows: stale } = await client.query<{ n: string }>(
      `SELECT COUNT(*) AS n
         FROM reservation_item r
         JOIN order_line_item oli ON oli.id = r.line_item_id AND oli.deleted_at IS NULL
         JOIN order_item oi ON oi.item_id = oli.id AND oi.deleted_at IS NULL
         JOIN "order" o ON o.id = oi.order_id AND o.deleted_at IS NULL
        WHERE r.deleted_at IS NULL AND r.location_id = $1 AND o.version <> oi.version`,
      [USA_LOC]
    );
    console.log(
      `   ${stale[0]?.n ?? 0} stale order_item version row(s) exist behind Miami reservations — the lib must skip them`
    );
    // If stale versions exist, the invariant above would have broken had the
    // join not filtered them (quantities double). So invariant == 0 with stale
    // > 0 is the strong form of this check; with stale == 0 it is vacuous.
    assert(
      Number(stale[0]?.n ?? 0) === 0 || invariantBreaks === 0,
      "stale versions present and still no double counting"
    );

    const ghost = await resolveReservationsBySku(knex, "__NO_SUCH_SKU__");
    assert(
      ghost.reserved === 0 &&
        ghost.rows.length === 0 &&
        ghost.unattributed === 0,
      "control: unknown SKU → 0 / [] / 0 (parameters bind)"
    );
  } finally {
    await client.end();
  }

  console.log(
    failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
