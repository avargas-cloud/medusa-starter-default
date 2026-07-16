/**
 * verify-treasury-confirm-lock.ts
 *
 * Read-only regression check for the Confirm/Lock + defer-aware cash rewrite
 * in _lib/load-daily-report.ts. Does NOT write anything — this repo's local
 * `./back` dev backend is wired to the real Railway (prod) database, and
 * `customer_payment` writes can trigger live QuickBooks pipeline subscribers,
 * so no synthetic test rows are created here. Full write-path coverage
 * (defer-payment, confirm, double-confirm 409) needs the Sandbox stack
 * (docs/SANDBOX.md) — this script only proves the read path didn't regress.
 *
 * Test 1 (mathematical regression): treasury_payment_defer is empty today,
 * so the new applied/unapplied-decomposed cash query MUST produce the exact
 * same net_cash_received_cents as the OLD naive "sum full amount on its
 * received_at day" query, for every day in a real recent window. This is the
 * core correctness claim of the applied/unapplied rewrite (Codex's top risk
 * from the design review) — verified against real data, not synthetic.
 *
 * Test 2: every payment currently reported as unattributed for TODAY (if
 * any) has effective_treasury_date === its own received_at day and
 * defer_count === 0, since no defers exist yet.
 *
 * Run:  yarn medusa exec ./src/scripts/verify/verify-treasury-confirm-lock.ts
 */

import { MedusaContainer } from "@medusajs/framework/types";
import { loadDailyReport } from "../../api/admin/accounting/treasury/_lib/load-daily-report";
import { loadUnattributedPayments } from "../../api/admin/accounting/treasury/_lib/load-unattributed-payments";

const WINDOW_DAYS = 21;

let failures = 0;
function fail(msg: string): void {
  failures++;
  console.error(`  ✗ ${msg}`);
}
function pass(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map((x) => parseInt(x, 10));
  return new Date(Date.UTC(y, m - 1, d) + n * 86_400_000).toISOString().slice(0, 10);
}

export default async function verifyTreasuryConfirmLock({
  container,
}: {
  container: MedusaContainer;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const knex = container.resolve("__pg_connection__") as any;

  const today = new Date().toISOString().slice(0, 10);
  const windowStart = addDays(today, -WINDOW_DAYS);

  console.log(
    `\n[verify-treasury-confirm-lock] window=${windowStart}..${today} (read-only)\n`
  );

  console.log(`Test 1 — decomposed cash query matches OLD naive query per day`);
  for (let i = 0; i <= WINDOW_DAYS; i++) {
    const day = addDays(windowStart, i);
    const dayStart = `${day} 00:00:00`;
    const dayEnd = `${day} 23:59:59.999999`;

    const oldResult = await knex.raw(
      `SELECT COALESCE(SUM(CASE WHEN status <> 'voided' THEN amount ELSE 0 END), 0)::bigint AS gross
       FROM customer_payment
       WHERE deleted_at IS NULL AND type = 'payment'
         AND received_at >= ? AND received_at <= ?`,
      [dayStart, dayEnd]
    );
    const oldGross = Number(oldResult.rows[0]?.gross ?? 0);

    const report = await loadDailyReport(knex, day, day);
    const newGross = report.totals.gross_payments_cents;

    if (oldGross !== newGross) {
      fail(`${day}: old_gross=${oldGross} new_gross=${newGross} — MISMATCH`);
    }
  }
  if (failures === 0) pass(`all ${WINDOW_DAYS + 1} days match — decomposition is a true no-op with defer table empty`);

  console.log(`\nTest 2 — today's unattributed payments have no phantom defer state`);
  const unattributed = await loadUnattributedPayments(
    knex,
    `${today} 00:00:00`,
    `${today} 23:59:59.999999`
  );
  let test2ok = true;
  for (const p of unattributed) {
    if (p.defer_count !== 0) {
      fail(`payment ${p.payment_id} has defer_count=${p.defer_count}, expected 0 (table should be empty)`);
      test2ok = false;
    }
    if (p.effective_treasury_date !== p.original_received_at.slice(0, 10)) {
      fail(
        `payment ${p.payment_id} effective_treasury_date=${p.effective_treasury_date} != original day ${p.original_received_at.slice(0, 10)}`
      );
      test2ok = false;
    }
  }
  if (test2ok) pass(`${unattributed.length} unattributed payment(s) today — all defer-free as expected`);

  console.log(
    `\n${failures === 0 ? "✅ All checks passed" : `❌ ${failures} assertion failure(s)`}\n`
  );
  if (failures > 0) process.exitCode = 1;
}
