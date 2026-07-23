/**
 * scripts/verify/verify-zero-amount-payment-qb-guard.ts
 *
 * Guards the $0-payment → QuickBooks invariant.
 *
 * A $0 customer_payment has nothing to record in QB. If one is enqueued
 * anyway, the bridge builds a $0 ReceivePaymentAdd that QB ACCEPTS WITHOUT
 * minting a document — no TxnID comes back, so the poller can never confirm
 * the row and it loops processing → timeout → failed → retry forever
 * (cpay 3230 / PAY-3230, 2026-07-23), leaving the POS spinner turning.
 *
 * Historically $0 payments came from the "anchor payment" anti-pattern in
 * ApplyCreditModal (a $0 cpay created solely to carry checkout-event audit
 * metadata). That metadata now lives in payment_application.metadata.
 *
 * Checks:
 *   1. No active $0 payment holds a non-terminal QB `payment` pipeline row.
 *   2. No active $0 payment carries metadata.qb_sync_status='pending'
 *      (spinner that can never resolve).
 *   3. Reports any surviving $0 "anchor payment" records.
 *
 * Read-only — modifies nothing. Exits 1 if any invariant is violated.
 *
 * Run: ./node_modules/.bin/tsx src/scripts/verify/verify-zero-amount-payment-qb-guard.ts
 */

import { Client } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.join(__dirname, "../../../.env") });

const NON_TERMINAL = ["pending", "processing", "submitted", "waiting"];

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  let failures = 0;

  try {
    // ── Check 1: $0 payments with a live QB payment row ──────────────────────
    const { rows: liveRows } = await client.query<{
      payment_id: string;
      display_id: number;
      row_id: string;
      status: string;
      retry_count: number;
      created_at: string;
    }>(
      `SELECT cp.id            AS payment_id,
              cp.display_id,
              p.id             AS row_id,
              p.status,
              COALESCE(p.retry_count, 0) AS retry_count,
              p.created_at
         FROM customer_payment cp
         JOIN qb_order_pipeline p ON p.reference_id = cp.id
        WHERE cp.amount = 0
          AND cp.deleted_at IS NULL
          AND p.step = 'payment'
          AND p.status = ANY($1::text[])
        ORDER BY p.created_at`,
      [NON_TERMINAL]
    );

    if (liveRows.length === 0) {
      console.log("✅ Check 1: no $0 payment holds a live QB `payment` row.");
    } else {
      failures++;
      console.log(
        `❌ Check 1: ${liveRows.length} $0 payment(s) with a live QB row — these will loop forever:`
      );
      for (const r of liveRows) {
        console.log(
          `   PAY-${r.display_id} (${r.payment_id}) → row ${r.row_id} status=${r.status} retries=${r.retry_count} created=${r.created_at}`
        );
      }
    }

    // ── Check 2: $0 payments stuck showing a sync spinner ────────────────────
    const { rows: spinnerRows } = await client.query<{
      payment_id: string;
      display_id: number;
      qb_sync_status: string;
    }>(
      `SELECT id AS payment_id, display_id,
              metadata->>'qb_sync_status' AS qb_sync_status
         FROM customer_payment
        WHERE amount = 0
          AND deleted_at IS NULL
          AND metadata->>'qb_sync_status' IN ('pending', 'creating')
        ORDER BY created_at`
    );

    if (spinnerRows.length === 0) {
      console.log("✅ Check 2: no $0 payment shows an unresolvable spinner.");
    } else {
      failures++;
      console.log(
        `❌ Check 2: ${spinnerRows.length} $0 payment(s) with qb_sync_status that can never resolve:`
      );
      for (const r of spinnerRows) {
        console.log(
          `   PAY-${r.display_id} (${r.payment_id}) qb_sync_status=${r.qb_sync_status}`
        );
      }
    }

    // ── Check 3: surviving $0 anchor payments (informational + gate) ─────────
    const { rows: anchors } = await client.query<{
      payment_id: string;
      display_id: number;
      capture_context: string;
      created_at: string;
    }>(
      `SELECT id AS payment_id, display_id,
              metadata->>'capture_context' AS capture_context,
              created_at
         FROM customer_payment
        WHERE amount = 0
          AND deleted_at IS NULL
        ORDER BY created_at`
    );

    if (anchors.length === 0) {
      console.log("✅ Check 3: zero $0 anchor payments alive.");
    } else {
      failures++;
      console.log(
        `❌ Check 3: ${anchors.length} $0 payment(s) still alive (anchor anti-pattern):`
      );
      for (const a of anchors) {
        console.log(
          `   PAY-${a.display_id} (${a.payment_id}) ctx=${a.capture_context ?? "(none)"} created=${a.created_at}`
        );
      }
    }

    console.log(
      failures === 0
        ? "\n✅ ALL CHECKS PASSED — the $0-payment guard is holding."
        : `\n❌ ${failures} CHECK(S) FAILED.`
    );
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
