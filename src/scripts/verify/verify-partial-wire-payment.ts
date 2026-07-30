/**
 * verify-partial-wire-payment
 *
 * A bill paid short must be finishable on a later wire.
 *
 * Everything happens inside ONE transaction that is ALWAYS rolled back, so the
 * script is safe against any database — it plants its own fixtures, proves the
 * behaviour on them, and leaves nothing behind. It asserts that too, by
 * re-counting its own rows after the rollback.
 *
 * WHAT IT PINS
 *   1. Two applications for the same bill are accepted (the old
 *      UNIQUE(bill_id) index no longer forbids the second one).
 *   2. Recreating that index with both rows present FAILS — which is what makes
 *      assertion 1 mean something. Without this control, assertion 1 would pass
 *      just as happily on a schema where the index never existed.
 *   3. UNIQUE(wire_id, bill_id) still holds: the same bill twice on the SAME
 *      wire is still rejected.
 *   4. The schedulable ceiling: `max(amount − Σ confirmed, 0)`. Underpaid bills
 *      expose their remainder; OVERPAID bills expose zero, because their excess
 *      settles as a wire credit and must not be schedulable as a payment.
 *   5. Production shape check (read-only): every bill with confirmed money is
 *      reported as underpaid / settled / overpaid, so the numbers behind the
 *      rule are visible rather than asserted in the abstract.
 *
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *     npx medusa exec ./src/scripts/verify/verify-partial-wire-payment.ts
 *
 * Run it with `tsx` and it exits 0 WITHOUT EXECUTING — this is a `medusa exec`
 * script (`export default`). The silence of a verifier is not approval.
 */

import { randomUUID } from "crypto";

import type { ExecArgs } from "@medusajs/framework/types";

import { schedulableCents } from "../../lib/china-finance/schedulable-amount";

type Raw = {
  raw: (sql: string, b?: unknown[]) => Promise<{ rows: unknown[] }>;
};
type Trx = Raw & { commit: () => Promise<void>; rollback: () => Promise<void> };

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Runs `fn` and reports whether Postgres rejected it. Each attempt gets its own
 *  SAVEPOINT: a failed statement poisons the whole transaction otherwise, and
 *  every later assertion would fail for that reason instead of its own. */
async function rejects(db: Raw, label: string, fn: () => Promise<unknown>): Promise<boolean> {
  const sp = `sp_${randomUUID().replace(/-/g, "")}`;
  await db.raw(`SAVEPOINT ${sp}`);
  try {
    await fn();
    await db.raw(`RELEASE SAVEPOINT ${sp}`);
    return false;
  } catch {
    await db.raw(`ROLLBACK TO SAVEPOINT ${sp}`);
    return true;
  }
}

/** The SAME function the reassign route calls — not a restatement of it. A
 *  verifier that keeps its own copy of the arithmetic goes green while
 *  production does something else. */
const schedulable = schedulableCents;

export default async function main({ container }: ExecArgs): Promise<void> {
  const knex = container.resolve("__pg_connection__") as Raw & {
    transaction?: () => Promise<Trx>;
  };
  if (!knex.transaction) {
    throw new Error("This verifier needs a transaction-capable connection");
  }

  // ── 0. Schema ──────────────────────────────────────────────────────────────
  console.log("\nSchema");
  const idx = await knex.raw(
    `SELECT indexname FROM pg_indexes
      WHERE tablename = 'china_wire_transfer_application'`
  );
  const names = new Set(
    (idx.rows as Array<{ indexname: string }>).map((r) => r.indexname)
  );
  check(
    "UNIQUE(bill_id) is gone — a bill is no longer pinned to one wire for life",
    !names.has("idx_cwta_bill_once"),
    "migration 1782000000000 has not run on this database"
  );
  check(
    "UNIQUE(wire_id, bill_id) survives — a bill still cannot appear twice on one wire",
    names.has("idx_cwta_wire_bill")
  );

  // ── 1. Behaviour, on fixtures, inside a doomed transaction ─────────────────
  console.log("\nA bill paid short, finished on a later wire (fixtures, rolled back)");
  const trx = await knex.transaction();
  const billId = randomUUID();
  const paidWireId = randomUUID();
  const nextWireId = randomUUID();
  try {
    await trx.raw(
      `INSERT INTO china_wire_transfer (id, status, sent_date, wire_amount_cents, bank_fee_cents, received_amount_cents)
       VALUES (?, 'confirmed', CURRENT_DATE, 376337, 0, 376337),
              (?, 'draft',     CURRENT_DATE, 1178,   0, 1178)`,
      [paidWireId, nextWireId]
    );
    // $3,775.15 invoice — the shape of VB-1053 the day this was written.
    await trx.raw(
      `INSERT INTO china_finance_bill
         (id, type, sort_order, document_type, invoice_number, payee, description,
          amount_cents, document_date, due_date)
       VALUES (?, 'vendor_bill', 0, 'commercial_invoice', 'VERIFY-PARTIAL', 'verify',
               'verify-partial-wire-payment fixture', 377515, CURRENT_DATE, CURRENT_DATE)`,
      [billId]
    );
    await trx.raw(
      `INSERT INTO china_wire_transfer_application (id, wire_transfer_id, bill_id, applied_cents, sort_order)
       VALUES (?, ?, ?, 376337, 0)`,
      [randomUUID(), paidWireId, billId]
    );

    const remainder = schedulable(377515, 376337);
    check("the remainder is what the invoice still owes ($11.78)", remainder === 1178, `${remainder}`);

    // THE case. Before migration 1782000000000 this INSERT raised
    // "china_wire_transfer_application with bill_id … already exists".
    //
    // Behind a SAVEPOINT even though it is expected to SUCCEED: on a database
    // that still has the old index it fails, and a failed statement aborts the
    // whole transaction — every assertion after it would then die of "current
    // transaction is aborted" instead of reporting its own verdict, which is
    // exactly when a verifier is least useful.
    const secondRejected = await rejects(trx, "second-application", () =>
      trx.raw(
        `INSERT INTO china_wire_transfer_application (id, wire_transfer_id, bill_id, applied_cents, sort_order)
         VALUES (?, ?, ?, ?, 0)`,
        [randomUUID(), nextWireId, billId, remainder]
      )
    );
    check("the remainder can be scheduled on a second wire", !secondRejected);

    const sum = await trx.raw(
      `SELECT COALESCE(SUM(applied_cents), 0)::int AS s, COUNT(*)::int AS n
         FROM china_wire_transfer_application WHERE bill_id = ?`,
      [billId]
    );
    const { s, n } = (sum.rows[0] ?? { s: 0, n: 0 }) as { s: number; n: number };
    check("the two applications together settle the invoice exactly", s === 377515, `${s}`);
    check("and they are two rows, not one rewritten", n === 2, `${n}`);

    // The control that gives assertion 1 its meaning.
    const indexRefuses = await rejects(trx, "recreate", () =>
      trx.raw(`CREATE UNIQUE INDEX ${"idx_cwta_bill_once_probe"} ON china_wire_transfer_application (bill_id)`)
    );
    check(
      "MUTATION CONTROL · recreating UNIQUE(bill_id) now fails — the two rows really do violate the old rule",
      indexRefuses
    );

    const sameWireTwice = await rejects(trx, "dup", () =>
      trx.raw(
        `INSERT INTO china_wire_transfer_application (id, wire_transfer_id, bill_id, applied_cents, sort_order)
         VALUES (?, ?, ?, 1, 1)`,
        [randomUUID(), nextWireId, billId]
      )
    );
    check("the same bill twice on the SAME wire is still rejected", sameWireTwice);

    // The ceiling, both directions.
    check("underpaid → the remainder is schedulable", schedulable(377515, 376337) === 1178);
    check("settled → nothing is schedulable", schedulable(376337, 376337) === 0);
    check(
      "OVERPAID → nothing is schedulable (the excess is a credit, not a payment)",
      schedulable(302500, 313650) === 0,
      "VB-1045's shape: $3,025.00 owed, $3,136.50 already applied"
    );
  } finally {
    await trx.rollback();
  }

  const leftovers = await knex.raw(
    `SELECT COUNT(*)::int AS n FROM china_finance_bill WHERE id = ?`,
    [billId]
  );
  check(
    "the fixtures left nothing behind",
    Number((leftovers.rows[0] as { n: number }).n) === 0
  );

  // ── 2. What production actually looks like (read-only) ─────────────────────
  console.log("\nLive bills carrying confirmed money");
  const live = await knex.raw(
    `SELECT b.id, b.invoice_number, b.amount_cents,
            COALESCE(SUM(a.applied_cents), 0)::int AS confirmed_cents
       FROM china_finance_bill b
       JOIN china_wire_transfer_application a ON a.bill_id = b.id
       JOIN china_wire_transfer w ON w.id = a.wire_transfer_id AND w.status = 'confirmed'
      GROUP BY b.id, b.invoice_number, b.amount_cents`
  );
  const rows = live.rows as Array<{
    invoice_number: string | null;
    amount_cents: number;
    confirmed_cents: number;
  }>;
  const under = rows.filter((r) => r.amount_cents > r.confirmed_cents);
  const over = rows.filter((r) => r.amount_cents < r.confirmed_cents);
  console.log(
    `  ${rows.length} bills · ${under.length} underpaid · ${over.length} overpaid · ` +
      `${rows.length - under.length - over.length} settled exactly`
  );
  for (const r of under) {
    console.log(
      `    UNDERPAID  ${r.invoice_number ?? "(no ref)"} — owes $${(
        (r.amount_cents - r.confirmed_cents) / 100
      ).toFixed(2)} of $${(r.amount_cents / 100).toFixed(2)}`
    );
  }
  for (const r of over) {
    console.log(
      `    OVERPAID   ${r.invoice_number ?? "(no ref)"} — $${(
        (r.confirmed_cents - r.amount_cents) / 100
      ).toFixed(2)} settles as a credit, not schedulable`
    );
  }
  check(
    "no bill reports a negative remainder (the clamp holds on live data)",
    rows.every((r) => schedulable(r.amount_cents, r.confirmed_cents) >= 0)
  );

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exitCode = 1;
}
