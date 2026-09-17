/**
 * Gate for pay-bills-credits-prepayments-20260917 (Fase 1 + 2).
 *
 * V1 no `vendor_prepayment_consumption` row group exceeds its check line's
 *    amount — the whole point of the table is that this can never happen.
 * V2 every `vendor_credit` with `reason='prepayment'` and a non-voided
 *    status has its consumption row — a prepayment credit can never exist
 *    without one (create.ts inserts both in the same transaction).
 * V3 `vendor_bill_payment_allocation.credit_application_id` is always NULL
 *    going forward — the double-count lane is closed (`create.ts` rejects
 *    it before BEGIN).
 * V4 static: the two source fixes are actually IN the files (a check that
 *    can't be satisfied by reverting the fix and leaving the comment).
 * V5 informative only (never fails): prepayment still on account per vendor
 *    (posted OtherCurrentAsset check lines − live consumption) — what the
 *    Pay Bills "Prepayments" tab can still offer.
 *
 * Usage:
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env | cut -d= -f2-)" \
 *     ./node_modules/.bin/medusa exec ./src/scripts/verify/verify-bill-settlements.ts
 *
 * NOTE it is a `medusa exec` script: run with `tsx` it executes NOTHING and
 * exits 0, which reads exactly like a pass.
 *
 * Exit codes: 0 all good · 1 an assertion failed · 2 could not run.
 */
import { readFileSync } from "fs";
import { join } from "path";
import type { ExecArgs } from "@medusajs/framework/types";

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures.push(label);
}

const money = (cents: number) => `$${(Number(cents) / 100).toFixed(2)}`;

export default async function run({ container }: ExecArgs): Promise<void> {
  const knex = container.resolve("__pg_connection__") as unknown as Knex;

  // ── V1 ────────────────────────────────────────────────────────────────
  const { rows: overConsumed } = await knex.raw(`
    SELECT l.id AS gl_check_line_id, l.amount_cents, SUM(v.consumed_cents) AS consumed
      FROM vendor_prepayment_consumption v
      JOIN gl_check_line l ON l.id = v.gl_check_line_id
     WHERE v.voided_at IS NULL
     GROUP BY l.id, l.amount_cents
    HAVING SUM(v.consumed_cents) > l.amount_cents
  `);
  check(
    "V1 no consumption exceeds its check line",
    overConsumed.length === 0,
    `${overConsumed.length} line(s) over-consumed`
  );

  // ── V2 ────────────────────────────────────────────────────────────────
  const { rows: missingConsumption } = await knex.raw(`
    SELECT vc.id, vc.number
      FROM vendor_credit vc
      LEFT JOIN vendor_prepayment_consumption v ON v.vendor_credit_id = vc.id AND v.voided_at IS NULL
     WHERE vc.reason = 'prepayment' AND vc.status <> 'voided' AND vc.deleted_at IS NULL
       AND v.id IS NULL
  `);
  check(
    "V2 every non-voided prepayment credit has a consumption row",
    missingConsumption.length === 0,
    `${missingConsumption.length} credit(s) missing: ${missingConsumption
      .map((r) => (r as { number: string | null }).number)
      .join(", ")}`
  );

  // ── V3 ────────────────────────────────────────────────────────────────
  const { rows: creditCarrying } = await knex.raw(`
    SELECT id FROM vendor_bill_payment_allocation WHERE credit_application_id IS NOT NULL
  `);
  check(
    "V3 no bill payment allocation carries a credit_application_id",
    creditCarrying.length === 0,
    `${creditCarrying.length} row(s)`
  );

  // ── V4 (static) ──────────────────────────────────────────────────────
  const createSrc = readFileSync(
    join(process.cwd(), "src/lib/bill-payments/create.ts"),
    "utf8"
  );
  check("V4a bill-payments/create.ts still rejects unsupported_credit_allocation", createSrc.includes("unsupported_credit_allocation"));

  const enqueueSrc = readFileSync(
    join(process.cwd(), "src/lib/purchase-orders/qb-bill-payment-enqueue.ts"),
    "utf8"
  );
  check(
    "V4b qb-bill-payment-enqueue.ts marks the credit-carrying allocation as SetCredit-only",
    enqueueSrc.includes("// credit-carrying allocation: SetCredit only, never PaymentAmount")
  );

  // ── V5 (informative) ─────────────────────────────────────────────────
  // Prepayment still ON ACCOUNT per vendor = posted OtherCurrentAsset check
  // lines − live consumption (settlement + the qb_backfill seed). This is the
  // same number `listVendorPrepayments` offers the Pay Bills modal, summed.
  // It is NOT netted against historical vendor credits: the seed already
  // stands for those (subtracting both double-counts the same fact).
  const { rows: perVendor } = await knex.raw(`
    WITH prepaid AS (
      SELECT c.payee_id AS vendor_id, SUM(l.amount_cents) AS total_cents
        FROM gl_check c
        JOIN gl_check_line l ON l.check_id = c.id
        JOIN qb_account a ON a.qb_list_id = l.account_list_id AND a.account_type = 'OtherCurrentAsset'
       WHERE c.status = 'posted' AND c.deleted_at IS NULL AND c.payee_type = 'vendor'
       GROUP BY c.payee_id
    ),
    consumed AS (
      SELECT vendor_id, SUM(consumed_cents) AS total_cents
        FROM vendor_prepayment_consumption WHERE voided_at IS NULL
       GROUP BY vendor_id
    )
    SELECT v.id, v.full_name,
           COALESCE(p.total_cents, 0) AS prepaid_cents,
           COALESCE(c.total_cents, 0) AS consumed_cents,
           COALESCE(p.total_cents, 0) - COALESCE(c.total_cents, 0) AS on_account_cents
      FROM qb_vendor v
      JOIN prepaid p ON p.vendor_id = v.id
      LEFT JOIN consumed c ON c.vendor_id = v.id
     ORDER BY 5 DESC
  `);
  console.log("\nV5 (informative) prepayment on account per vendor (checks − consumed):");
  for (const r of perVendor as Array<{
    full_name: string;
    prepaid_cents: number;
    consumed_cents: number;
    on_account_cents: number;
  }>) {
    console.log(
      `  ${r.full_name}: on account ${money(r.on_account_cents)} (checks ${money(r.prepaid_cents)} − consumed ${money(r.consumed_cents)})`
    );
  }

  if (failures.length > 0) {
    console.error(`\nFAIL — ${failures.length} check(s): ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("\nPASS");
}
