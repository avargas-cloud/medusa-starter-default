/**
 * verify-cash-close.ts — READ-ONLY. Recomputes a Cash Close for one business
 * day through the same `computeCashClose` the route calls (never a copy of
 * the SQL) and asserts the ladder ties to the cent. Against
 * `--day 2026-09-17` it also asserts the figures verified in prod on
 * 2026-09-17/18 (see plan cash-close-20260918 / spec-backend.md §Data facts).
 *
 * Usage:
 *   env DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env)" \
 *     ./node_modules/.bin/medusa exec ./src/scripts/verify/verify-cash-close.ts -- --day 2026-09-17
 *
 * Exit codes: 0 all good · 1 a mismatch was found · 2 could not run.
 */
import type { ExecArgs } from "@medusajs/framework/types";

import { computeCashClose } from "../../lib/cash-close/service";
import type { Knexish } from "../../lib/cash-close/load-day";
import { getBusinessDateString } from "../../lib/date/et";

function yesterdayEt(): string {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return getBusinessDateString(yesterday);
}

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const EXPECTED_09_17: Record<string, number> = {
  received_cents: 401806,
  received_count: 11,
  surcharge_cents: 7169,
  invoiced_cents: 623921,
  invoiced_count: 15,
  invoice_today_cents: 386801,
  order_deposit_cents: 15000,
  unexplained_cents: 5,
  on_account_cents: 1873,
  on_account_count: 1,
  refunds_paid_out_cents: 0,
  refunds_count: 0,
  credit_memos_today_cents: 0,
  credit_memos_count: 0,
  estimates_issued_count: 3,
  estimates_issued_cents: 168471,
};

let failures = 0;

function check(label: string, actual: number, expected: number): void {
  const ok = actual === expected;
  console.log(`  ${ok ? "✅" : "❌"} ${label}: ${actual} (expected ${expected})`);
  if (!ok) failures++;
}

export default async function run({ container }: ExecArgs): Promise<void> {
  const day = argValue("--day") ?? yesterdayEt();
  const knex = container.resolve("__pg_connection__") as unknown as Knexish;

  console.log(`\nCash Close verify — business day ${day}\n`);

  const counterRows = await knex.raw<{ value: string }>(
    `SELECT value::text FROM document_number_counter WHERE name = 'cash_close'`
  );
  if (counterRows.rows.length === 0) {
    console.warn(
      "⚠️  'cash_close' counter row is missing — the Cash Close migration hasn't run here. Skipping the counter check."
    );
  } else {
    console.log(`  ✅ document_number_counter('cash_close') exists (value=${counterRows.rows[0]!.value})`);
  }

  const snapshot = await computeCashClose(knex, day);
  const t = snapshot.totals;

  console.log("\nTotals:");
  console.log(`  received        ${t.received_cents} (${t.received_count} payments)`);
  console.log(`  surcharge       ${t.surcharge_cents}`);
  console.log(`  invoiced        ${t.invoiced_cents} (${t.invoiced_count})`);
  console.log(`  invoice_today   ${t.invoice_today_cents}`);
  console.log(`  invoice_earlier ${t.invoice_earlier_cents}`);
  console.log(`  order_deposit   ${t.order_deposit_cents}`);
  console.log(`  estimate_dep.   ${t.estimate_deposit_cents}`);
  console.log(`  held_deposit    ${t.held_deposit_cents}`);
  console.log(`  held_credit     ${t.held_credit_cents}`);
  console.log(`  unexplained     ${t.unexplained_cents} (${t.unexplained_count})`);
  console.log(`  paid_today      ${t.paid_today_cents}`);
  console.log(`  paid_earlier    ${t.paid_earlier_cents}`);
  console.log(`  paid_sc         ${t.paid_store_credit_cents}`);
  console.log(`  on_account      ${t.on_account_cents} (${t.on_account_count})`);
  console.log(`  refunds         ${t.refunds_paid_out_cents} (${t.refunds_count})`);
  console.log(`  credit_memos    ${t.credit_memos_today_cents} (${t.credit_memos_count})`);
  console.log(`  estimates       ${t.estimates_issued_cents} (${t.estimates_issued_count})`);
  console.log(`  orders          ${t.orders_issued_cents} (${t.orders_issued_count})`);
  console.log(`  balanced        ${snapshot.balanced}`);

  console.log("\nLadder:");
  for (const line of snapshot.ladder) {
    console.log(`  ${line.kind === "end" ? "=" : line.cents >= 0 ? "+" : "-"} ${line.label}: ${line.cents}`);
  }
  // computeSnapshot already threw CASH_CLOSE_LADDER_MISMATCH if it didn't
  // tie — reaching here means the ladder ties. Assert it explicitly anyway
  // so a future refactor that swallows that error still gets caught here.
  const endLine = snapshot.ladder[snapshot.ladder.length - 1]!;
  check("ladder ties to end", endLine.cents, t.received_cents - t.refunds_paid_out_cents);

  if (day === "2026-09-17") {
    console.log("\nAgainst the 2026-09-17 expected figures:");
    check("received_cents", t.received_cents, EXPECTED_09_17.received_cents!);
    check("received_count", t.received_count, EXPECTED_09_17.received_count!);
    check("surcharge_cents", t.surcharge_cents, EXPECTED_09_17.surcharge_cents!);
    check("invoiced_cents", t.invoiced_cents, EXPECTED_09_17.invoiced_cents!);
    check("invoiced_count", t.invoiced_count, EXPECTED_09_17.invoiced_count!);
    check("invoice_today_cents", t.invoice_today_cents, EXPECTED_09_17.invoice_today_cents!);
    check("order_deposit_cents", t.order_deposit_cents, EXPECTED_09_17.order_deposit_cents!);
    check("unexplained_cents", t.unexplained_cents, EXPECTED_09_17.unexplained_cents!);
    check("on_account_cents", t.on_account_cents, EXPECTED_09_17.on_account_cents!);
    check("on_account_count", t.on_account_count, EXPECTED_09_17.on_account_count!);
    check("refunds_paid_out_cents", t.refunds_paid_out_cents, EXPECTED_09_17.refunds_paid_out_cents!);
    check("refunds_count", t.refunds_count, EXPECTED_09_17.refunds_count!);
    check("credit_memos_today_cents", t.credit_memos_today_cents, EXPECTED_09_17.credit_memos_today_cents!);
    check("credit_memos_count", t.credit_memos_count, EXPECTED_09_17.credit_memos_count!);
    check("estimates_issued_count", t.estimates_issued_count, EXPECTED_09_17.estimates_issued_count!);
    check("estimates_issued_cents", t.estimates_issued_cents, EXPECTED_09_17.estimates_issued_cents!);

    // paid_earlier_cents + paid_store_credit_cents together are the
    // spec's informal "paid_earlier 235247" (the two are tracked as
    // separate CashCloseTotals fields per types.ts, the spec's prose
    // summary lumped them) — assert the sum, not either field alone.
    check(
      "paid_earlier_cents + paid_store_credit_cents",
      t.paid_earlier_cents + t.paid_store_credit_cents,
      235247
    );

    // orders_issued for 09/17: 12 orders / 224011 cents. The plan's spec said
    // "40 / 630692", but that figure came from a LEFT JOIN on order_summary
    // WITHOUT picking the latest version (order_summary keeps one row per
    // version, so each order was counted several times). The loader must
    // read the newest version only — this assertion is what proves it.
    check("orders_issued_count", t.orders_issued_count, 12);
    check("orders_issued_cents", t.orders_issued_cents, 224011);
  }

  console.log(`\n${failures === 0 ? "OK" : `FAILED (${failures} mismatch(es))`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}
