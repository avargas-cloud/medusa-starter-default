/**
 * E2E — Treasury Daily Split with un-ordered cash — SANDBOX ONLY.
 *
 * Proves, against a running backend and the sandbox DB, the two rules shipped
 * on 2026-09-17 after the 09/14 incident (Operating −$8,773.86, wire −$8,473.45):
 *
 *   1. Un-ordered cash (a customer deposit with no order) does NOT feed the
 *      COGS pool: China/Local stay exactly as without it, Operating grows by
 *      the full amount, Σ splits = net cash.
 *   2. A bucket pick that fits moves the full face value Operating → bucket.
 *      A pick that would drive the source bucket negative is REJECTED: splits
 *      untouched, BUCKET_MOVE_EXCEEDS_SOURCE warning, the row blocks again
 *      (credit_stale + blocking) and POST daily/log answers 409.
 *
 * Writes only synthetic rows (ids prefixed `e2etreas_`) and deletes them in
 * `finally`. Refuses anything that is not localhost:909x / :5499.
 *
 *   ./back-sb                                   # or a worktree backend on 909x
 *   SANDBOX_BASE_URL=http://localhost:9097 \
 *   ./node_modules/.bin/tsx src/scripts/tests/e2e-treasury-unlinked-cash-sandbox.ts
 */
import { Pool } from "pg";

const BASE = process.env.SANDBOX_BASE_URL ?? "http://localhost:9099";
const DB =
  process.env.SANDBOX_DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";
if (!/^http:\/\/(localhost|127\.0\.0\.1):909\d(\/|$)/.test(BASE))
  throw new Error(`REFUSED: BASE must be localhost:909x — got ${BASE}`);
if (!/localhost:5499\//.test(DB)) throw new Error("REFUSED: DB must be the sandbox on :5499");

type Split = { code: string; amount_cents: number };
type Report = {
  totals: { net_cash_received_cents: number; unapplied_cash_cents: number; tax_collected_cents: number };
  splits: Split[];
  warnings: Array<{ code: string; detail?: string; sample_ids: string[] }>;
  unattributed_payments: Array<{ payment_id: string; blocking: boolean; credit_stale: boolean; unapplied_cents: number }>;
  reconciliation: { delta_cents: number; sum_of_splits_cents: number };
};

const amt = (r: Report, code: string) => r.splits.find((s) => s.code === code)?.amount_cents ?? 0;
const pool_ = (r: Report) => amt(r, "china_cogs") + amt(r, "local_cogs");
let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function main(): Promise<void> {
  const email = process.env.SANDBOX_TEST_EMAIL ?? "sandbox@test.com";
  const password = process.env.SANDBOX_TEST_PASSWORD ?? "sandbox123";
  const auth = (await (
    await fetch(`${BASE}/auth/user/emailpass`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    })
  ).json()) as { token?: string };
  if (!auth.token) throw new Error("login failed — see docs/SANDBOX.md (test user)");
  const headers = { authorization: `Bearer ${auth.token}`, "content-type": "application/json" };
  const getReport = async (day: string): Promise<Report> => {
    const res = await fetch(`${BASE}/admin/accounting/treasury/daily?date=${day}`, { headers });
    const json = (await res.json()) as { data?: Report; report?: Report } & Report;
    if (!res.ok) throw new Error(`GET daily ${day} → ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
    return json.data ?? json.report ?? json;
  };

  const pg = new Pool({ connectionString: DB });
  const stamp = Date.now().toString(36);
  const payId = `cpay_e2etreas_${stamp}`;
  const refundId = `cpay_e2etreas_rf_${stamp}`;
  try {
    // Earliest unlocked day with ordered sales: the lock gate then answers for
    // THIS day (no EARLIER_DAY_PENDING in the way).
    const dayRow = await pg.query<{ d: string; customer_id: string }>(
      `SELECT to_char(x.d, 'YYYY-MM-DD') AS d,
              (SELECT customer_id FROM customer_payment WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1) AS customer_id
         FROM (SELECT (received_at AT TIME ZONE 'America/New_York')::date d
                 FROM customer_payment
                WHERE type='payment' AND status='applied' AND deleted_at IS NULL
                GROUP BY 1) x
        WHERE x.d > COALESCE((SELECT max(distribution_date)::date FROM treasury_distribution_log), '2000-01-01'::date)
          AND x.d <= current_date
        ORDER BY x.d ASC LIMIT 1`
    );
    const day = dayRow.rows[0]?.d;
    const customerId = dayRow.rows[0]?.customer_id;
    if (!day || !customerId) throw new Error("no unlocked day with sales in sandbox");
    console.log(`day=${day} base=${BASE}`);

    const base = await getReport(day);
    check("baseline Σ splits = net", base.reconciliation.delta_cents === 0);
    const P = Math.max(5_000_000, pool_(base) + 1_000_000);

    // ── 1. un-ordered deposit ────────────────────────────────────────────────
    await pg.query(
      `INSERT INTO customer_payment (id, customer_id, source, type, amount, raw_amount, currency, method, status, received_at, batch_day, display_id, metadata)
       VALUES ($1, $2, 'pos', 'payment', $3::numeric, jsonb_build_object('value', $3::numeric::text, 'precision', 20), 'usd', 'ach', 'available', ($4 || ' 16:00:00+00')::timestamptz, $4::date, 990000 + (random()*9000)::int, '{"e2e":"treasury-unlinked-cash"}'::jsonb)`,
      [payId, customerId, P, day]
    );
    const r1 = await getReport(day);
    check("net grows by the deposit", r1.totals.net_cash_received_cents === base.totals.net_cash_received_cents + P);
    check("unapplied_cash_cents ≥ deposit", r1.totals.unapplied_cash_cents >= P, `${r1.totals.unapplied_cash_cents}`);
    check("China unchanged (deposit carries no COGS)", amt(r1, "china_cogs") === amt(base, "china_cogs"), `${amt(base, "china_cogs")} → ${amt(r1, "china_cogs")}`);
    check("Local unchanged", amt(r1, "local_cogs") === amt(base, "local_cogs"));
    check("Operating grows by the full deposit", amt(r1, "operating") === amt(base, "operating") + P);
    check("Σ splits = net", r1.reconciliation.delta_cents === 0);
    const row1 = r1.unattributed_payments.find((p) => p.payment_id === payId);
    check("deposit listed as unattributed & blocking", !!row1 && row1.blocking === true);

    // ── 2a. a pick that FITS moves face value Operating → China ─────────────
    const pick = await fetch(`${BASE}/admin/accounting/treasury/daily/payment-credit/resolve`, {
      method: "POST",
      headers,
      body: JSON.stringify({ payment_id: payId, bucket: "china_cogs", amount_cents: P, reason: "e2e" }),
    });
    check("resolve → 2xx", pick.ok, `${pick.status}`);
    const r2 = await getReport(day);
    check("China = base + deposit", amt(r2, "china_cogs") === amt(base, "china_cogs") + P);
    check("Operating back to base", amt(r2, "operating") === amt(base, "operating"));
    check("no BUCKET_MOVE_EXCEEDS_SOURCE", !r2.warnings.some((w) => w.code === "BUCKET_MOVE_EXCEEDS_SOURCE"));
    check("row no longer blocking", r2.unattributed_payments.find((p) => p.payment_id === payId)?.blocking === false);
    check("Σ splits = net", r2.reconciliation.delta_cents === 0);

    // ── 2b. a refund drains Operating below the pick → the move is REJECTED ──
    const R = amt(base, "operating") + P;
    await pg.query(
      `INSERT INTO customer_payment (id, customer_id, source, type, amount, raw_amount, currency, method, status, received_at, batch_day, metadata, qb)
       VALUES ($1, $2, 'pos', 'refund', $3::numeric, jsonb_build_object('value', $3::numeric::text, 'precision', 20), 'usd', 'check', 'refunded', ($4 || ' 17:00:00+00')::timestamptz, $4::date, '{"e2e":"treasury-unlinked-cash"}'::jsonb, '{"check_txn_id":"E2E-TREAS"}'::jsonb)`,
      [refundId, customerId, R, day]
    );
    const r3 = await getReport(day);
    const rej = r3.warnings.find((w) => w.code === "BUCKET_MOVE_EXCEEDS_SOURCE");
    check("BUCKET_MOVE_EXCEEDS_SOURCE warning present", !!rej, rej?.detail?.slice(0, 160));
    // The refund shrinks the pool basis (never below 0), so China may be ≤ base;
    // what must NOT happen is China carrying the rejected $P.
    check("China did NOT receive the rejected pick", amt(r3, "china_cogs") <= amt(base, "china_cogs"), `${amt(r3, "china_cogs")} ≤ ${amt(base, "china_cogs")}`);
    check("Operating ≥ 0", amt(r3, "operating") >= 0, `${amt(r3, "operating")}`);
    check("no bucket negative", r3.splits.every((s) => s.amount_cents >= 0), JSON.stringify(r3.splits.map((s) => [s.code, s.amount_cents])));
    const row3 = r3.unattributed_payments.find((p) => p.payment_id === payId);
    check("row blocks again (credit_stale + blocking)", row3?.blocking === true && row3?.credit_stale === true);
    check("Σ splits = net", r3.reconciliation.delta_cents === 0);
    const lock = await fetch(`${BASE}/admin/accounting/treasury/daily/log`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "confirm", date: day }),
    });
    const lockJson = (await lock.json().catch(() => ({}))) as { error?: string };
    check("POST daily/log → 409", lock.status === 409, `${lock.status} ${lockJson.error?.slice(0, 80)}`);
    check("…and names the deposit", JSON.stringify(lockJson).includes(payId));
  } finally {
    await pg.query(`DELETE FROM treasury_payment_credit_resolution WHERE payment_id = $1`, [payId]);
    await pg.query(`DELETE FROM customer_payment WHERE id = ANY($1::text[])`, [[payId, refundId]]);
    const left = await pg.query(`SELECT count(*)::int AS n FROM customer_payment WHERE id LIKE 'cpay_e2etreas_%'`);
    console.log(`cleanup: ${left.rows[0].n} synthetic rows left`);
    await pg.end();
  }
  console.log(failures === 0 ? "PASS" : `FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error("❌", e instanceof Error ? e.message : e); process.exit(1); });
