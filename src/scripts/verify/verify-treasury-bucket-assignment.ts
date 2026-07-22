/**
 * verify-treasury-bucket-assignment.ts
 *
 * Verification for the 2026-07-21 Treasury bucket-assignment redesign:
 *  1. Pure derivation of `current_bucket` (deriveCurrentBucket + its wiring
 *     through deriveCmMovement) — no DB needed.
 *  2. Refund-netting invariants of load-unattributed-payments, run READ-ONLY
 *     against the DATABASE_URL env if present: unapplied can never go
 *     negative nor exceed amount − applied.
 *  3. With SEED_FIXTURES=1 (SANDBOX ONLY — writes!): seeds three synthetic
 *     payments on a far-future day and exercises the full loader behavior:
 *     refunded remainders netted out as soon as recorded (with AND without a
 *     QB Write Check — no gate), genuine remainder blocking, "as credit"
 *     resolution unblocks, drifted resolution goes stale and re-blocks.
 *     Cleans up after itself.
 *
 * Run (sandbox):
 *     DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa' SEED_FIXTURES=1 \
 *       npx tsx src/scripts/verify/verify-treasury-bucket-assignment.ts
 *
 * Exits 0 on success, 1 on any failed assertion.
 */

import {
  deriveCmMovement,
  deriveCurrentBucket,
} from "../../api/admin/accounting/treasury/_lib/load-cm-movements";
import { loadUnattributedPayments } from "../../api/admin/accounting/treasury/_lib/load-unattributed-payments";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`, extra ?? "");
  }
}

console.log("— deriveCurrentBucket —");
check("pure china", deriveCurrentBucket(5000, 0) === "china_cogs");
check("pure local", deriveCurrentBucket(0, 5000) === "local_cogs");
check("mixed 60/40", deriveCurrentBucket(6000, 4000) === "mixed");
check("mixed tiny sliver still mixed", deriveCurrentBucket(9999, 1) === "mixed");
check("zero backing = unknown", deriveCurrentBucket(0, 0) === "unknown");

console.log("— deriveCmMovement carries current_bucket —");
const d = deriveCmMovement({
  payment_application_id: "papp_test",
  amount_applied_cents: 10000,
  backing_china_cents: 0,
  backing_local_cents: 8000,
  consumption_china_cents: 7000,
  consumption_local_cents: 0,
  backing_lines_total: 2,
  backing_lines_costed: 2,
});
check("local-backed row → current_bucket local_cogs", d.current_bucket === "local_cogs");
check(
  "cross-category still suggests COGS overlap (audit context intact)",
  d.suggested_movement?.from === "local_cogs" &&
    d.suggested_movement?.to === "china_cogs" &&
    d.suggested_movement?.cents === 7000
);

async function liveChecks(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.log("— live checks skipped (no DATABASE_URL) —");
    return;
  }
  console.log("— live read-only checks (2026-07-20) —");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Client } = require("pg");
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  const pg = {
    raw: async (sql: string, params: unknown[]) => {
      // knex-style `?` placeholders → pg $n
      let i = 0;
      const converted = sql.replace(/\?/g, () => `$${++i}`);
      return client.query(converted, params);
    },
  };
  try {
    const recent = await loadUnattributedPayments(
      pg,
      "2026-07-01 00:00:00",
      "2026-07-31 23:59:59.999999"
    );
    for (const r of recent) {
      check(`PAY-${r.display_id}: unapplied >= 0`, r.unapplied_cents >= 0, r);
      check(
        `PAY-${r.display_id}: applied+unapplied <= amount (refund netted, never inflated)`,
        r.applied_cents + r.unapplied_cents <= r.amount_cents,
        r
      );
    }

    if (process.env.SEED_FIXTURES === "1") {
      await runFixtureChecks(pg);
    } else {
      console.log("— fixture checks skipped (SEED_FIXTURES != 1) —");
    }
  } finally {
    await client.end();
  }
}

/** Far-future day: can't collide with real data or a locked treasury day. */
const FIX_DAY = "2099-01-01";
const FIX = {
  refundedWithCheck: "cpay_vfy_refcheck",
  refundedNoCheck: "cpay_vfy_refpend",
  genuine: "cpay_vfy_genuine",
  app: "papp_vfy_genuine",
  tpcr: "tpcr_vfy_genuine",
};

interface Pg {
  raw: (sql: string, params: unknown[]) => Promise<{ rows: any[] }>;
}

async function cleanupFixtures(pg: Pg): Promise<void> {
  await pg.raw(
    `DELETE FROM treasury_payment_credit_resolution WHERE payment_id IN (?, ?, ?)`,
    [FIX.refundedWithCheck, FIX.refundedNoCheck, FIX.genuine]
  );
  await pg.raw(
    `DELETE FROM payment_application WHERE id IN (?, 'papp_vfy_refcheck', 'papp_vfy_refpend')`,
    [FIX.app]
  );
  await pg.raw(`DELETE FROM customer_payment WHERE id IN (?, ?, ?)`, [
    FIX.refundedWithCheck,
    FIX.refundedNoCheck,
    FIX.genuine,
  ]);
}

async function runFixtureChecks(pg: Pg): Promise<void> {
  console.log(`— fixture checks (synthetic day ${FIX_DAY}, sandbox) —`);
  await cleanupFixtures(pg);

  const insertPayment = async (
    id: string,
    amountCents: number,
    status: string,
    metadata: Record<string, unknown>,
    qb: Record<string, unknown> | null
  ) =>
    pg.raw(
      `INSERT INTO customer_payment
         (id, customer_id, amount, raw_amount, received_at, type, method, status, metadata, qb)
       VALUES (?, 'cus_vfy_fixture', ?, ?::jsonb, ?::timestamptz, 'payment', 'credit_card', ?, ?::jsonb, ?::jsonb)`,
      [
        id,
        amountCents,
        JSON.stringify({ value: String(amountCents), precision: 20 }),
        `${FIX_DAY} 12:00:00+00`,
        status,
        JSON.stringify(metadata),
        qb ? JSON.stringify(qb) : null,
      ]
    );

  // (a) $100 payment, $40 refunded, QB check exists → netted to $60... but we
  // apply $60 too, so it nets to zero and must NOT be returned at all.
  await insertPayment(
    FIX.refundedWithCheck,
    10000,
    "partial_refunded",
    { refund_amount: 4000 },
    { check_txn_id: "VFY-CHECK-1" }
  );
  await pg.raw(
    `INSERT INTO payment_application (id, payment_id, order_id, amount_applied, raw_amount_applied, applied_at)
     VALUES ('papp_vfy_refcheck', ?, 'order_vfy_fixture', 6000, '{"value":"6000","precision":20}'::jsonb, ?::timestamptz)`,
    [FIX.refundedWithCheck, `${FIX_DAY} 12:05:00+00`]
  );

  // (b) $100 payment, $40 refunded, NO QB check yet → nets out the same as
  // (a): the BAMS refund already pulled the money; no check gate.
  await insertPayment(
    FIX.refundedNoCheck,
    10000,
    "partial_refunded",
    { refund_amount: 4000 },
    null
  );
  await pg.raw(
    `INSERT INTO payment_application (id, payment_id, order_id, amount_applied, raw_amount_applied, applied_at)
     VALUES ('papp_vfy_refpend', ?, 'order_vfy_fixture', 6000, '{"value":"6000","precision":20}'::jsonb, ?::timestamptz)`,
    [FIX.refundedNoCheck, `${FIX_DAY} 12:05:00+00`]
  );

  // (c) genuine $68.05 remainder on a $808.19 payment.
  await insertPayment(FIX.genuine, 80819, "partially_applied", {}, null);
  await pg.raw(
    `INSERT INTO payment_application (id, payment_id, order_id, amount_applied, raw_amount_applied, applied_at)
     VALUES (?, ?, 'order_vfy_fixture', 74014, '{"value":"74014","precision":20}'::jsonb, ?::timestamptz)`,
    [FIX.app, FIX.genuine, `${FIX_DAY} 12:05:00+00`]
  );

  try {
    const load = () =>
      loadUnattributedPayments(
        pg,
        `${FIX_DAY} 00:00:00`,
        `${FIX_DAY} 23:59:59.999999`
      );

    let rows = await load();
    check(
      "refund WITH check fully netted — row absent",
      rows.find((r) => r.payment_id === FIX.refundedWithCheck) === undefined
    );
    check(
      "refund WITHOUT check ALSO fully netted — row absent (no check gate)",
      rows.find((r) => r.payment_id === FIX.refundedNoCheck) === undefined
    );
    const gen = rows.find((r) => r.payment_id === FIX.genuine);
    check(
      "genuine remainder $68.05, blocking, no credit resolution",
      gen !== undefined &&
        gen.unapplied_cents === 6805 &&
        gen.blocking === true &&
        gen.credit_bucket === null,
      gen
    );

    // "As credit" resolution with matching snapshot → unblocks.
    await pg.raw(
      `INSERT INTO treasury_payment_credit_resolution
         (id, payment_id, bucket, amount_cents) VALUES (?, ?, 'local_cogs', 6805)`,
      [FIX.tpcr, FIX.genuine]
    );
    rows = await load();
    const resolved = rows.find((r) => r.payment_id === FIX.genuine);
    check(
      "credit resolution (matching amount) → bucket local_cogs, NOT blocking",
      resolved !== undefined &&
        resolved.credit_bucket === "local_cogs" &&
        resolved.credit_stale === false &&
        resolved.blocking === false,
      resolved
    );

    // Drift the remainder (extra $10 application) → resolution stale, re-blocks.
    await pg.raw(
      `UPDATE payment_application SET amount_applied = 75014 WHERE id = ?`,
      [FIX.app]
    );
    rows = await load();
    const stale = rows.find((r) => r.payment_id === FIX.genuine);
    check(
      "remainder drifted → resolution stale, blocking again",
      stale !== undefined && stale.credit_stale === true && stale.blocking === true,
      stale
    );
  } finally {
    await cleanupFixtures(pg);
    console.log("  (fixtures cleaned up)");
  }
}

liveChecks()
  .then(() => {
    if (failures > 0) {
      console.error(`\n${failures} check(s) FAILED`);
      process.exit(1);
    }
    console.log("\nAll checks passed.");
  })
  .catch((err) => {
    console.error("verify crashed:", err);
    process.exit(1);
  });
