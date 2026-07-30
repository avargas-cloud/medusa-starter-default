/**
 * E2E — `deposit_total`, the number a customer-facing DOCUMENT states.
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * The order document showed the /orders list's "In Deposit" — money still
 * SITTING on the order — as its Deposit line, and derived Balance from it.
 * S11179 was deposited in full ($18,917.94) and $2,141.71 had been billed, so
 * the unused half was $16,776.23 and the document printed a Balance of
 * $2,141.71: exactly the money already collected.
 *
 * THE CLAIM UNDER TEST
 * --------------------
 * Invoicing RECLASSIFIES money from deposit to applied; it does not receive
 * any. So `deposit_total` (= applied + deposit, derived by
 * recompute_order_money) must NOT move when an invoice consumes a deposit, and
 * the document's Balance must stay at zero for a fully deposited order.
 *
 * WHY THERE IS A POSITIVE CONTROL
 * -------------------------------
 * Phase 3 asserts a number did NOT change, and this repo has already shipped an
 * E2E whose "nothing happened" passed with the entire fix deleted, because the
 * fixture was ineligible for an unrelated reason. An unchanged-assertion is
 * worth nothing unless the same test proves it can SEE change: phase 4 voids
 * the payment and requires deposit_total to collapse to zero. If phase 4 ever
 * passes trivially, phase 3 is vacuous and both are lying.
 *
 * ROLLBACK: everything runs in one transaction that is always rolled back, so
 * the sandbox is left byte-identical. The triggers fire inside it — that is the
 * point, they are what is being tested — and their writes roll back too.
 *
 * Run: cd backend && ./node_modules/.bin/tsx src/scripts/tests/e2e-order-deposit-total-sandbox.ts
 */
import { Pool, PoolClient } from "pg";

const SANDBOX_URL =
  process.env.SANDBOX_DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";

if (!/localhost:5499|127\.0\.0\.1:5499/.test(SANDBOX_URL)) {
  console.error(
    `REFUSED: this writes payments and applications. It runs against the sandbox on 5499 only.\n  got: ${SANDBOX_URL}`
  );
  process.exit(2);
}

let failures = 0;
const pass = (m: string) => console.log(`  PASS  ${m}`);
const fail = (m: string) => {
  failures++;
  console.log(`  FAIL  ${m}`);
};
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

type Snapshot = {
  appliedCents: number;
  depositCents: number;
  receivedCents: number;
  mirrorDeposit: number | null;
  mirrorApplied: number | null;
  mirrorTotal: number | null;
  hasTotalKey: boolean;
  orderTotalCents: number;
};

async function snapshot(c: PoolClient, orderId: string): Promise<Snapshot> {
  const { rows } = await c.query(
    `SELECT omp.applied_cents, omp.deposit_cents, omp.received_cents, omp.order_total_cents,
            NULLIF(o.metadata->>'referential_deposit','')::numeric AS m_dep,
            NULLIF(o.metadata->>'applied_total','')::numeric       AS m_app,
            NULLIF(o.metadata->>'deposit_total','')::numeric       AS m_tot,
            (o.metadata ? 'deposit_total')                         AS has_tot
       FROM order_money_projection omp
       JOIN "order" o ON o.id = omp.order_id
      WHERE omp.order_id = $1`,
    [orderId]
  );
  const r = rows[0];
  return {
    appliedCents: Number(r.applied_cents),
    depositCents: Number(r.deposit_cents),
    receivedCents: Number(r.received_cents),
    orderTotalCents: Number(r.order_total_cents),
    mirrorDeposit: r.m_dep == null ? null : Number(r.m_dep),
    mirrorApplied: r.m_app == null ? null : Number(r.m_app),
    mirrorTotal: r.m_tot == null ? null : Number(r.m_tot),
    hasTotalKey: r.has_tot === true,
  };
}

/** The three invariants that must hold at EVERY step, not just at the end. */
function checkInvariants(label: string, s: Snapshot) {
  if (!s.hasTotalKey) {
    fail(`${label}: metadata.deposit_total key is absent (absent is not zero)`);
  }
  const expectedMirror = Number(((s.appliedCents + s.depositCents) / 100).toFixed(2));
  if (s.mirrorTotal !== expectedMirror) {
    fail(`${label}: mirror ${s.mirrorTotal} != applied+deposit ${expectedMirror}`);
  }
  if (s.receivedCents !== s.appliedCents + s.depositCents) {
    fail(`${label}: received_cents ${s.receivedCents} != applied+deposit ${s.appliedCents + s.depositCents}`);
  }
  const halves = Number(((s.mirrorDeposit ?? 0) + (s.mirrorApplied ?? 0)).toFixed(2));
  if (s.mirrorTotal !== halves) {
    fail(`${label}: mirror ${s.mirrorTotal} != referential_deposit + applied_total ${halves}`);
  }
}

/** What the POS Order Summary renders. Mirror of OrderSummary.tsx. */
const documentBalance = (totalCents: number, depositTotalCents: number) =>
  Math.max(totalCents - depositTotalCents, 0);

async function main() {
  const pool = new Pool({ connectionString: SANDBOX_URL });
  const c = await pool.connect();

  try {
    await c.query("BEGIN");

    // ── Fixture: a real order with a readable total and no money on it ──────
    const { rows: cand } = await c.query(
      `SELECT omp.order_id, o.metadata->>'document_number' AS doc, omp.order_total_cents, o.customer_id
         FROM order_money_projection omp
         JOIN "order" o ON o.id = omp.order_id
        WHERE omp.applied_cents = 0 AND omp.deposit_cents = 0
          AND omp.order_total_cents BETWEEN 50000 AND 500000
          AND o.customer_id IS NOT NULL
        ORDER BY omp.order_id
        LIMIT 1`
    );
    if (cand.length === 0) {
      console.error("No eligible fixture order in the sandbox — cannot run.");
      process.exit(2);
    }
    const orderId: string = cand[0].order_id;
    const doc: string = cand[0].doc ?? orderId;
    const customerId: string = cand[0].customer_id;
    const totalCents = Number(cand[0].order_total_cents);
    console.log(`\nFixture: ${doc} (${orderId}) — total ${money(totalCents)}\n`);

    const payId = `cpay_e2e_deptot_${Date.now()}`;
    const appId = `papp_e2e_deptot_${Date.now()}`;
    // Not the whole order: a partial bill is the shape that produced the bug.
    const billedCents = Math.round(totalCents * 0.3);

    // ── Phase 1: the order receives a deposit for its FULL total ────────────
    console.log("Phase 1 — deposit lands for the full order total");
    await c.query(
      `INSERT INTO customer_payment
         (id, customer_id, source, type, amount, currency, method, status,
          locked_order_id, received_at, raw_amount, created_at, updated_at)
       VALUES ($1, $2, 'pos', 'payment', $3::numeric, 'usd', 'other', 'available',
               $4, now(), jsonb_build_object('value', $5::text, 'precision', 20), now(), now())`,
      // $3 and $5 carry the same number on purpose: reusing one placeholder in
      // both a numeric column and jsonb_build_object makes Postgres deduce two
      // types for it and refuse the statement (42P08).
      [payId, customerId, totalCents, orderId, String(totalCents)]
    );
    const s1 = await snapshot(c, orderId);
    checkInvariants("phase 1", s1);
    if (s1.depositCents === totalCents) pass(`In Deposit = ${money(s1.depositCents)} (the whole order)`);
    else fail(`In Deposit ${money(s1.depositCents)} != total ${money(totalCents)}`);
    if (s1.appliedCents === 0) pass("Paid Amt = $0.00 (nothing billed yet)");
    else fail(`Paid Amt ${money(s1.appliedCents)} != 0`);
    if (s1.receivedCents === totalCents) pass(`deposit_total = ${money(s1.receivedCents)}`);
    else fail(`deposit_total ${money(s1.receivedCents)} != total ${money(totalCents)}`);
    if (documentBalance(totalCents, s1.receivedCents) === 0) pass("document Balance = $0.00");
    else fail(`document Balance ${money(documentBalance(totalCents, s1.receivedCents))} != 0`);

    // ── Phase 2: an invoice consumes part of it ─────────────────────────────
    // This RECLASSIFIES money. Nothing arrives, nothing leaves.
    console.log(`\nPhase 2 — an invoice bills ${money(billedCents)} against the deposit`);
    await c.query(
      `INSERT INTO payment_application
         (id, payment_id, invoice_id, order_id, amount_applied, applied_at,
          raw_amount_applied, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::numeric, now(),
               jsonb_build_object('value', $6::text, 'precision', 20), now(), now())`,
      [appId, payId, `posinv_e2e_deptot_${Date.now()}`, orderId, billedCents, String(billedCents)]
    );
    const s2 = await snapshot(c, orderId);
    checkInvariants("phase 2", s2);
    if (s2.appliedCents === billedCents) pass(`Paid Amt moved to ${money(s2.appliedCents)}`);
    else fail(`Paid Amt ${money(s2.appliedCents)} != ${money(billedCents)}`);
    if (s2.depositCents === totalCents - billedCents) pass(`In Deposit shrank to ${money(s2.depositCents)}`);
    else fail(`In Deposit ${money(s2.depositCents)} != ${money(totalCents - billedCents)}`);

    // THE CLAIM. This is the assertion the whole change exists to make true.
    if (s2.receivedCents === s1.receivedCents) {
      pass(`deposit_total UNCHANGED at ${money(s2.receivedCents)} — invoicing moved money, it did not receive it`);
    } else {
      fail(`deposit_total moved ${money(s1.receivedCents)} -> ${money(s2.receivedCents)}`);
    }
    const bal2 = documentBalance(totalCents, s2.receivedCents);
    if (bal2 === 0) {
      pass("document Balance still $0.00 — the S11179 symptom is gone");
    } else {
      fail(`document Balance ${money(bal2)} (the bug: it equals what was billed, ${money(billedCents)})`);
    }
    // What the OLD document did, printed so the regression stays legible.
    console.log(
      `        (old behaviour, unused half only: Deposit ${money(s2.depositCents)} / Balance ${money(documentBalance(totalCents, s2.depositCents))})`
    );

    // ── Phase 3: POSITIVE CONTROL — the money actually leaves ───────────────
    // Without this, phase 2's "unchanged" could pass on a fixture where nothing
    // was ever capable of changing.
    console.log("\nPhase 3 — positive control: void the payment, money must leave");
    await c.query(`UPDATE customer_payment SET status = 'voided', updated_at = now() WHERE id = $1`, [payId]);
    await c.query(
      `UPDATE payment_application SET voided_at = now(), updated_at = now() WHERE id = $1`,
      [appId]
    );
    const s3 = await snapshot(c, orderId);
    checkInvariants("phase 3", s3);
    if (s3.receivedCents === 0) {
      pass("deposit_total collapsed to $0.00 — the test can see movement, so phase 2 means something");
    } else {
      fail(
        `deposit_total ${money(s3.receivedCents)} after voiding everything. ` +
          `Phase 2's unchanged-assertion is VACUOUS if this cannot move.`
      );
    }
    const bal3 = documentBalance(totalCents, s3.receivedCents);
    if (bal3 === totalCents) pass(`document Balance back to the full ${money(bal3)}`);
    else fail(`document Balance ${money(bal3)} != ${money(totalCents)}`);

    console.log("\nRolling back — the sandbox keeps nothing from this run.");
    await c.query("ROLLBACK");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
    await pool.end();
  }

  console.log(failures === 0 ? "\nRESULT: PASS\n" : `\nRESULT: FAIL (${failures})\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
