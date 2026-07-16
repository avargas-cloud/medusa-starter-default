/**
 * backfill-treasury-confirmed-days.ts
 *
 * Grandfathers historical Treasury days as already-confirmed/locked so the
 * new "Confirm Transfers" gate (blocks on unlinked payments, see
 * api/admin/accounting/treasury/daily/log/route.ts) only bites going forward
 * — real wires for these historical days were already executed manually
 * before this control existed.
 *
 * Range: [START_DATE, END_DATE] inclusive.
 *   START_DATE = 2026-05-25 — the day `treasury_bucket` (the bucket-split
 *   feature itself) went live in prod; before that there was no split policy
 *   to "confirm".
 *   END_DATE   = 2026-07-14 — the new blocking rule applies from 2026-07-15
 *   forward.
 *
 * For each day not already present in treasury_distribution_log:
 *   - Compute loadDailyReport(day, day) — a live single-day report.
 *   - If reconciliation.delta_cents !== 0, SKIP (never force-insert a broken
 *     invariant) and list it for manual review.
 *   - Otherwise insert ONE already-executed row, BYPASSING the new
 *     unattributed-payments gate on purpose — historical unlinked payments
 *     shouldn't block grandfathering a day whose wires already happened.
 *
 * Idempotent: days already in treasury_distribution_log are skipped (counted
 * separately), so re-running is a no-op except for genuinely new gaps.
 *
 * Usage:
 *   cd backend
 *   yarn medusa exec ./src/scripts/migrations/backfill-treasury-confirmed-days.ts            # DRY RUN
 *   APPLY=true yarn medusa exec ./src/scripts/migrations/backfill-treasury-confirmed-days.ts  # APPLY
 */

import { MedusaContainer } from "@medusajs/framework/types";
import { ulid } from "ulid";
import { loadDailyReport } from "../../api/admin/accounting/treasury/_lib/load-daily-report";

const APPLY = process.env.APPLY === "true";
const START_DATE = "2026-05-25";
const END_DATE = "2026-07-14";
const NOTES =
  "backfill: pre-control historical day, wires already executed manually before this feature existed";

function enumerateDays(from: string, to: string): string[] {
  const days: string[] = [];
  let cur = from;
  while (cur <= to) {
    days.push(cur);
    const [y, m, d] = cur.split("-").map((n) => parseInt(n, 10));
    const next = new Date(Date.UTC(y, m - 1, d) + 86_400_000);
    cur = next.toISOString().slice(0, 10);
  }
  return days;
}

export default async function backfillTreasuryConfirmedDays({
  container,
}: {
  container: MedusaContainer;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const knex = container.resolve("__pg_connection__") as any;

  console.log(
    `\n[backfill-treasury-confirmed-days] mode=${APPLY ? "APPLY" : "DRY_RUN"} range=${START_DATE}..${END_DATE}\n`
  );

  const days = enumerateDays(START_DATE, END_DATE);

  const existingResult = await knex.raw(
    `SELECT distribution_date::text AS distribution_date
     FROM treasury_distribution_log
     WHERE distribution_date >= ?::date AND distribution_date <= ?::date`,
    [START_DATE, END_DATE]
  );
  const existingSet = new Set<string>(
    (existingResult.rows ?? []).map((r: { distribution_date: string }) => r.distribution_date)
  );

  const inserted: string[] = [];
  const alreadyExisting: string[] = [];
  const deltaMismatch: Array<{ date: string; delta_cents: number }> = [];

  for (const day of days) {
    if (existingSet.has(day)) {
      alreadyExisting.push(day);
      continue;
    }

    const report = await loadDailyReport(knex, day, day);

    if (report.reconciliation.delta_cents !== 0) {
      deltaMismatch.push({ date: day, delta_cents: report.reconciliation.delta_cents });
      console.log(
        `  [SKIP delta!=0] ${day} — delta_cents=${report.reconciliation.delta_cents} — needs manual review`
      );
      continue;
    }

    if (APPLY) {
      const id = `tdl_${ulid()}`;
      await knex.raw(
        `INSERT INTO treasury_distribution_log
           (id, distribution_date, generated_by_user_id, snapshot_json,
            executed_at, executed_by_user_id, notes)
         VALUES (?, ?, NULL, ?::jsonb, now(), NULL, ?)`,
        [id, day, JSON.stringify(report), NOTES]
      );
    }
    inserted.push(day);
    console.log(
      `  [${APPLY ? "INSERTED" : "WOULD INSERT"}] ${day} — net_cash=${(
        report.totals.net_cash_received_cents / 100
      ).toFixed(2)} unattributed=${report.unattributed_payments.length}`
    );
  }

  console.log(`\n[backfill-treasury-confirmed-days] summary`);
  console.log(`  ${APPLY ? "inserted" : "would insert"}: ${inserted.length}`);
  console.log(`  already existing (skipped): ${alreadyExisting.length}`);
  console.log(`  skipped — delta_cents != 0 (manual review): ${deltaMismatch.length}`);
  if (deltaMismatch.length > 0) {
    console.log(`  manual review dates:`);
    for (const d of deltaMismatch) console.log(`    ${d.date} — delta_cents=${d.delta_cents}`);
  }
  if (!APPLY) {
    console.log(`\n  DRY RUN — no rows written. Re-run with APPLY=true to apply.\n`);
  }
}
