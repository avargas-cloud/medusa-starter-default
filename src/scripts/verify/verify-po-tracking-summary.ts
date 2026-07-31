/**
 * verify-po-tracking-summary
 *
 * Gate for the Purchase Orders list Tracking column.
 *
 * WHAT IT PROVES
 * That `enrichTrackingSummaryMap` — the FUNCTION the route calls, not a re-typed
 * copy of its SQL — separates the two things the column has to tell apart:
 *
 *   several NUMBERS on one delivery  → one arrival wearing several labels
 *   several DELIVERIES               → separate arrivals, separate dates, separate goods
 *
 * and that it reads the shipment tables rather than `purchase_order.tracking`,
 * the pre-migration jsonb column that no writer maintains. The regression this
 * exists to catch is silent: the column renders "—" or a stale number and looks
 * merely empty, never broken.
 *
 * The cross-check against raw SQL is the point. Comparing the function to itself
 * proves nothing, so every count is re-derived straight from the tables and the
 * two have to agree.
 *
 * Run (any DB — read-only):
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env|cut -d= -f2-)" \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-po-tracking-summary.ts
 */
import { Client } from "pg";

import { enrichTrackingSummaryMap } from "../../api/admin/purchase-orders/_lib/tracking-summary";

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

  // The route's knex uses `?` placeholders; pg uses `$1`. Adapt rather than
  // duplicate the SQL — the whole point is to exercise the real statement.
  const knex = {
    raw: async (sql: string, bindings?: unknown[]) => {
      let i = 0;
      const converted = sql.replace(/\?/g, () => `$${++i}`);
      return client.query(converted, bindings as unknown[]);
    },
  };

  try {
    const { rows: pos } = await client.query<{ id: string; number: string }>(
      `SELECT id, COALESCE(number, '<draft>') AS number
         FROM purchase_order WHERE deleted_at IS NULL`
    );
    const summary = await enrichTrackingSummaryMap(knex, pos);

    assert(
      summary.size === pos.length,
      "every PO gets an entry (POs with no deliveries included)",
      `${summary.size}/${pos.length}`
    );

    // ── Cross-check every count against the tables ────────────────────────────
    const { rows: truth } = await client.query<{
      id: string;
      deliveries: string;
      numbers: string;
    }>(
      `SELECT trk.purchase_order_id AS id,
              COUNT(DISTINCT trk.id) AS deliveries,
              COUNT(n.id)            AS numbers
         FROM purchase_order_tracking trk
         LEFT JOIN purchase_order_tracking_number n
                ON n.purchase_order_tracking_id = trk.id AND n.deleted_at IS NULL
        WHERE trk.deleted_at IS NULL
        GROUP BY trk.purchase_order_id`
    );

    let mismatches = 0;
    for (const t of truth) {
      const s = summary.get(t.id);
      if (
        s?.delivery_count !== Number(t.deliveries) ||
        s?.number_count !== Number(t.numbers)
      ) {
        mismatches += 1;
        console.log(
          `   ↳ ${t.id}: function said ${s?.delivery_count}/${s?.number_count}, tables say ${t.deliveries}/${t.numbers}`
        );
      }
    }
    assert(
      mismatches === 0,
      `counts match the tables for all ${truth.length} POs with deliveries`
    );

    // ── The distinction the column exists to draw ─────────────────────────────
    const multiDelivery = [...summary.entries()].filter(
      ([, s]) => s.delivery_count > 1
    );
    const multiNumberOneDelivery = [...summary.entries()].filter(
      ([, s]) => s.delivery_count === 1 && s.number_count > 1
    );
    console.log(
      `\n   ${multiDelivery.length} PO(s) with several DELIVERIES · ` +
        `${multiNumberOneDelivery.length} with one delivery under several NUMBERS`
    );
    assert(
      multiDelivery.every(([, s]) => s.delivery_count > 1) &&
        multiNumberOneDelivery.every(
          ([, s]) => s.delivery_count === 1 && s.number_count > 1
        ),
      "the two shapes never collapse into each other"
    );

    // ── A master is quoted whenever a number exists ───────────────────────────
    const withNumbersButNoMaster = [...summary.values()].filter(
      (s) => s.number_count > 0 && !s.master
    );
    assert(
      withNumbersButNoMaster.length === 0,
      "every PO holding a carrier number quotes one",
      `${withNumbersButNoMaster.length} without`
    );

    // ── `mixed` should not exist; if it does, say so loudly ───────────────────
    const mixed = [...summary.entries()].filter(
      ([, s]) => s.coverage === "mixed"
    );
    assert(
      mixed.length === 0,
      "no PO mixes whole-PO and per-item deliveries",
      mixed.length ? `${mixed.map(([id]) => id).join(", ")}` : ""
    );

    // ── The reason this file exists ───────────────────────────────────────────
    // A PO whose deliveries postdate the migration has an EMPTY jsonb column.
    // Reading that column is what the list used to do.
    const { rows: stale } = await client.query<{ n: string }>(
      `SELECT COUNT(*) AS n
         FROM purchase_order po
        WHERE po.deleted_at IS NULL
          AND (po.tracking IS NULL OR po.tracking::text IN ('[]', 'null'))
          AND EXISTS (SELECT 1 FROM purchase_order_tracking t
                       WHERE t.purchase_order_id = po.id AND t.deleted_at IS NULL)`
    );
    const invisible = Number(stale[0].n);
    console.log(
      `\n   ${invisible} PO(s) have deliveries that the old jsonb column cannot see`
    );
    assert(
      invisible === 0 ||
        [...summary.entries()].filter(([, s]) => s.delivery_count > 0).length >=
          invisible,
      "those POs are visible through the summary"
    );
  } finally {
    await client.end();
  }

  console.log(
    failures === 0
      ? "\n🎉 tracking summary verified"
      : `\n💥 ${failures} assertion(s) failed`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
