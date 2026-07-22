/**
 * set-payment-batch-day.ts — move a customer payment to a different day.
 *
 * Sets batch_day AND received_at (16:00Z = noon ET on the target day, same
 * semantics as a backdated create from /transactions/new) and enqueues the
 * payment_txndate_change consolidator step so the QB ReceivePayment's TxnDate
 * follows (mirrors PATCH /admin/customer-payments/:id — dispatch reads the
 * LIVE batch_day and fetches a fresh EditSequence).
 *
 * Guards: refuses voided payments, invalid/future days, and target days that
 * are already treasury-locked (executed distribution).
 *
 * Usage (from backend/, prod .env):
 *   DISPLAY_ID=3199 TARGET_DAY=2026-07-21 ./node_modules/.bin/tsx src/scripts/fix/set-payment-batch-day.ts
 *   Add APPLY=true to execute (dry-run by default).
 */
import { Pool } from "pg";
import dotenv from "dotenv";
dotenv.config();

import { writePipelineRow } from "../../lib/quickbooks/pipeline/row-mutations";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const displayId = Number(process.env.DISPLAY_ID);
  const targetDay = process.env.TARGET_DAY ?? "";
  const apply = process.env.APPLY === "true";

  if (!displayId || !/^\d{4}-\d{2}-\d{2}$/.test(targetDay)) {
    throw new Error("Set DISPLAY_ID=<n> and TARGET_DAY=YYYY-MM-DD");
  }

  const { rows } = await pool.query(
    `SELECT id, display_id, amount, method, status, received_at, batch_day,
            metadata->>'qb_txn_id' AS qb_txn_id,
            metadata->>'is_sales_receipt_payment' AS is_sr,
            metadata->>'order_id' AS order_id
       FROM customer_payment WHERE display_id = $1`,
    [displayId]
  );
  if (rows.length !== 1) throw new Error(`Expected 1 payment for display_id ${displayId}, got ${rows.length}`);
  const p = rows[0];
  console.log("Payment:", p);

  if (p.status === "voided") throw new Error("Refusing to edit a voided payment");

  const { rows: lockRows } = await pool.query(
    `SELECT 1 FROM treasury_distribution_log
      WHERE distribution_date = $1::date AND executed_at IS NOT NULL LIMIT 1`,
    [targetDay]
  );
  if (lockRows.length > 0) {
    throw new Error(`Treasury for ${targetDay} is already confirmed & locked — aborting`);
  }

  if (!apply) {
    console.log(`DRY RUN — would set batch_day=${targetDay}, received_at=${targetDay}T16:00:00Z and enqueue payment_txndate_change (qb_txn_id=${p.qb_txn_id ?? "none"})`);
    return;
  }

  await pool.query(
    `UPDATE customer_payment
        SET batch_day = $2,
            received_at = ($2 || 'T16:00:00Z')::timestamptz,
            updated_at = now()
      WHERE id = $1`,
    [p.id, targetDay]
  );
  console.log(`Updated ${p.id} → batch_day=${targetDay}, received_at=${targetDay}T16:00:00Z`);

  // QB re-sync — same gate as the PATCH route: standalone payments need a real
  // qb_txn_id; SR-embedded payments move the whole Sales Receipt via order_id.
  const hasQbDoc =
    (p.is_sr === "true" && !!p.order_id) ||
    (!!p.qb_txn_id && p.qb_txn_id !== "SYNCED_VIA_RECEIPT");
  if (hasQbDoc) {
    const rowId = await writePipelineRow({
      orderId: p.order_id ?? null,
      referenceId: p.id,
      referenceType: "customer_payment",
      step: "payment_txndate_change",
      status: "pending",
      medusaRefNumber: `PAY-${p.display_id}`,
    });
    console.log(`Enqueued payment_txndate_change row ${rowId} — consolidator will move the QB TxnDate`);
  } else {
    console.log("No QB doc for this payment — DB-only change, nothing to enqueue");
  }
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err.message);
    pool.end();
    process.exit(1);
  });
