/**
 * backfill-order-referential-deposit-from-paid-invoices.ts
 *
 * Fixes POS order list visibility for historical invoices that are fully paid
 * in the POS invoice/finance ledger, but whose parent Medusa order metadata
 * has a stale or missing referential_deposit.
 *
 * Scope:
 *   - pos_invoice rows are non-voided.
 *   - Sum(balance_due) <= 0 and amount_paid covers total.
 *   - order.metadata.referential_deposit is lower than invoice amount_paid.
 *
 * This does NOT touch customer_payment or payment_application. It only backfills
 * the POS display field used by Orders → Deposit/Paid Amt/Fully Paid state.
 *
 * Usage:
 *   DRY RUN: yarn ts-node src/scripts/fix/backfill-order-referential-deposit-from-paid-invoices.ts
 *   APPLY:   APPLY=1 yarn ts-node src/scripts/fix/backfill-order-referential-deposit-from-paid-invoices.ts
 *            yarn ts-node src/scripts/fix/backfill-order-referential-deposit-from-paid-invoices.ts --execute
 */

import { Client } from "pg";

type Candidate = {
  order_id: string;
  order_number: string;
  current_deposit_dollars: number;
  target_deposit_dollars: number;
  missing_dollars: number;
  invoice_numbers: string;
  invoice_count: number;
  store_credit_cents: number;
  non_credit_cents: number;
};

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function money(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

async function main() {
  const apply = process.env.APPLY === "1" || process.argv.includes("--execute");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }

  const client = new Client({
    connectionString: databaseUrl,
    ssl:
      databaseUrl.includes("railway") || databaseUrl.includes("sslmode")
        ? { rejectUnauthorized: false }
        : undefined,
  });
  await client.connect();

  console.log(
    `\n[order-deposit-backfill] Mode: ${apply ? "APPLY" : "DRY-RUN"}\n`
  );

  const { rows } = await client.query(`
    WITH paid_invoices AS (
      SELECT
        pi.order_id,
        COUNT(*) AS invoice_count,
        SUM(pi.total)::numeric AS invoice_total_cents,
        SUM(pi.amount_paid)::numeric AS invoice_paid_cents,
        SUM(pi.balance_due)::numeric AS invoice_balance_cents,
        STRING_AGG(pi.invoice_number::text, ',' ORDER BY pi.invoice_number::text) AS invoice_numbers
      FROM pos_invoice pi
      WHERE pi.status <> 'voided'
        AND pi.deleted_at IS NULL
      GROUP BY pi.order_id
      HAVING SUM(pi.total)::numeric > 0
         AND SUM(pi.balance_due)::numeric <= 0
         AND SUM(pi.amount_paid)::numeric >= SUM(pi.total)::numeric - 1
    ),
    applications AS (
      SELECT
        pa.order_id,
        SUM(
          CASE
            WHEN pa.voided_at IS NULL
             AND (cp.type = 'credit_memo' OR cp.method = 'credit_memo')
            THEN pa.amount_applied
            ELSE 0
          END
        )::numeric AS store_credit_cents,
        SUM(
          CASE
            WHEN pa.voided_at IS NULL
             AND NOT (cp.type = 'credit_memo' OR cp.method = 'credit_memo')
            THEN pa.amount_applied
            ELSE 0
          END
        )::numeric AS non_credit_cents
      FROM payment_application pa
      JOIN customer_payment cp ON cp.id = pa.payment_id
      WHERE pa.deleted_at IS NULL
      GROUP BY pa.order_id
    ),
    orders AS (
      SELECT
        o.id,
        COALESCE(o.metadata->>'document_number', '#' || o.display_id::text) AS order_number,
        o.metadata,
        COALESCE(NULLIF(o.metadata->>'referential_deposit', '')::numeric, 0) AS current_deposit_dollars
      FROM "order" o
      WHERE o.deleted_at IS NULL
    )
    SELECT
      o.id AS order_id,
      o.order_number,
      o.current_deposit_dollars::text AS current_deposit_dollars,
      (pi.invoice_paid_cents / 100.0)::text AS target_deposit_dollars,
      ((pi.invoice_paid_cents / 100.0) - o.current_deposit_dollars)::text AS missing_dollars,
      pi.invoice_numbers,
      pi.invoice_count::int,
      COALESCE(a.store_credit_cents, 0)::text AS store_credit_cents,
      COALESCE(a.non_credit_cents, 0)::text AS non_credit_cents
    FROM paid_invoices pi
    JOIN orders o ON o.id = pi.order_id
    LEFT JOIN applications a ON a.order_id = pi.order_id
    WHERE o.current_deposit_dollars + 0.01 < (pi.invoice_paid_cents / 100.0)
    ORDER BY ((pi.invoice_paid_cents / 100.0) - o.current_deposit_dollars) DESC, o.order_number ASC
  `);

  const candidates: Candidate[] = rows.map((r: any) => ({
    order_id: String(r.order_id),
    order_number: String(r.order_number),
    current_deposit_dollars: Number(r.current_deposit_dollars),
    target_deposit_dollars: Number(r.target_deposit_dollars),
    missing_dollars: Number(r.missing_dollars),
    invoice_numbers: String(r.invoice_numbers ?? ""),
    invoice_count: Number(r.invoice_count),
    store_credit_cents: Math.round(Number(r.store_credit_cents)),
    non_credit_cents: Math.round(Number(r.non_credit_cents)),
  }));

  if (!candidates.length) {
    console.log("[order-deposit-backfill] Zero candidates found.\n");
    await client.end();
    return;
  }

  const withStoreCredit = candidates.filter((c) => c.store_credit_cents > 0);
  const creditOnly = candidates.filter(
    (c) => c.store_credit_cents > 0 && c.non_credit_cents === 0
  );
  const mixed = candidates.filter(
    (c) => c.store_credit_cents > 0 && c.non_credit_cents > 0
  );
  const nonCreditOnly = candidates.filter(
    (c) => c.store_credit_cents === 0 && c.non_credit_cents > 0
  );
  const missingTotal = candidates.reduce((sum, c) => sum + c.missing_dollars, 0);

  console.log(`Found ${candidates.length} order(s) to backfill:`);
  console.log(`  has store credit : ${withStoreCredit.length}`);
  console.log(`  credit only      : ${creditOnly.length}`);
  console.log(`  mixed            : ${mixed.length}`);
  console.log(`  non-credit only  : ${nonCreditOnly.length}`);
  console.log(`  missing total    : ${money(missingTotal)}\n`);

  console.log(
    "order  | current  | target   | missing  | credit   | other    | invoices"
  );
  console.log(
    "-------+----------+----------+----------+----------+----------+----------"
  );
  for (const c of candidates) {
    console.log(
      `${c.order_number.padEnd(6)} | ${money(c.current_deposit_dollars).padStart(8)} | ${money(c.target_deposit_dollars).padStart(8)} | ${money(c.missing_dollars).padStart(8)} | ${dollars(c.store_credit_cents).padStart(8)} | ${dollars(c.non_credit_cents).padStart(8)} | ${c.invoice_numbers}`
    );
  }
  console.log();

  if (!apply) {
    console.log(
      "[order-deposit-backfill] DRY-RUN — no changes made. Re-run with APPLY=1 to update order.metadata.referential_deposit.\n"
    );
    await client.end();
    return;
  }

  let updated = 0;
  let failed = 0;
  for (const c of candidates) {
    try {
      await client.query(
        `
        UPDATE "order"
        SET
          metadata = COALESCE(metadata, '{}'::jsonb)
            || jsonb_build_object(
              'referential_deposit', $1::numeric,
              'referential_deposit_backfill', jsonb_build_object(
                'applied_at', $2::text,
                'reason', $3::text,
                'previous_deposit', $4::numeric,
                'target_deposit', $5::numeric,
                'missing_deposit', $6::numeric,
                'invoice_numbers', $7::text,
                'invoice_count', $8::int,
                'store_credit_applied_cents', $9::int,
                'non_credit_applied_cents', $10::int
              )
            ),
          updated_at = now()
        WHERE id = $11
          AND COALESCE(NULLIF(metadata->>'referential_deposit', '')::numeric, 0) + 0.01 < $12::numeric
        `,
        [
          c.target_deposit_dollars,
          new Date().toISOString(),
          "retroactive-fix: POS invoice was fully paid but order referential_deposit did not include all applied payments/credits",
          c.current_deposit_dollars,
          c.target_deposit_dollars,
          c.missing_dollars,
          c.invoice_numbers,
          c.invoice_count,
          c.store_credit_cents,
          c.non_credit_cents,
          c.order_id,
          c.target_deposit_dollars,
        ]
      );
      updated++;
      console.log(
        `  updated ${c.order_number}: ${money(c.current_deposit_dollars)} -> ${money(c.target_deposit_dollars)}`
      );
    } catch (err: any) {
      failed++;
      console.error(`  FAILED ${c.order_number}: ${err.message}`);
    }
  }

  console.log(
    `\n[order-deposit-backfill] Done. updated=${updated} failed=${failed}\n`
  );

  await client.end();
}

main().catch((err) => {
  console.error("[order-deposit-backfill] Fatal:", err);
  process.exit(1);
});
