/**
 * test-refund-payment-recovery.ts — synthetic E2E of the refund_payment retry
 * path against a LOCAL snapshot DB with a dead bridge URL. Calls the REAL
 * runRefundPaymentRecovery (never a reimplementation).
 *
 * Proves: (1) a 'failed' row with due next_retry_at + confirmed write_check is
 * claimed; (2) the dead-bridge attempt reschedules it with backoff
 * (retry_count+1, future next_retry_at); (3) a future next_retry_at is NOT
 * re-claimed. Cleans up after itself.
 *
 * Run (from backend/):
 *   env DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5501/ecopowertech_preview \
 *       QB_BRIDGE_URL=http://127.0.0.1:9/disabled \
 *       ./node_modules/.bin/tsx src/scripts/debug/test-refund-payment-recovery.ts
 */
import { randomUUID } from "crypto";
import { getDbPool } from "../../api/utils/db-pool";
import { runRefundPaymentRecovery } from "../../lib/quickbooks/consolidator/recovery-pass";

const DB = process.env.DATABASE_URL ?? "";
if (!/127\.0\.0\.1|localhost/.test(DB)) {
  console.error("❌ Refusing to run: DATABASE_URL is not a local snapshot DB");
  process.exit(1);
}
if (!/127\.0\.0\.1:9\//.test(process.env.QB_BRIDGE_URL ?? "")) {
  console.error("❌ Refusing to run: QB_BRIDGE_URL must point at the dead port");
  process.exit(1);
}

const logger = {
  info: (m: string) => console.log(m),
  warn: (m: string) => console.log(m),
  error: (m: string) => console.log(m),
};

async function main() {
  const pool = getDbPool();
  const wcId = randomUUID();
  const rpId = randomUUID();
  let failures = 0;

  // Any customer_payment whose customer has a QB ListID (snapshot data)
  const { rows: cpRows } = await pool.query(`
    SELECT cp.id FROM customer_payment cp
    JOIN customer c ON c.id = cp.customer_id
    WHERE c.metadata->>'qb_list_id' IS NOT NULL
      AND cp.metadata->>'qb_txn_id' IS NOT NULL
    LIMIT 1`);
  if (!cpRows[0]) {
    console.error("❌ No suitable customer_payment in snapshot");
    process.exit(1);
  }
  const cpayId = cpRows[0].id;
  console.log(`Using snapshot customer_payment ${cpayId}`);

  try {
    await pool.query(
      `INSERT INTO qb_order_pipeline (id, step, status, reference_id, reference_type, qb_txn_id, medusa_ref_number, created_at, updated_at)
       VALUES ($1, 'write_check', 'confirmed', $2, 'customer_payment', 'TEST-CHECK-TXN', 'TEST Refund', NOW(), NOW())`,
      [wcId, cpayId]
    );
    await pool.query(
      `INSERT INTO qb_order_pipeline (id, step, status, reference_id, reference_type, depends_on, retry_count, next_retry_at, payload, medusa_ref_number, created_at, updated_at)
       VALUES ($1, 'refund_payment', 'failed', $2, 'customer_payment', $3, 0, NOW() - INTERVAL '1 minute',
               '{"type":"direct_payment","originalPaymentTxnId":"TEST-ORIG-TXN","txnDate":"2026-07-22"}'::jsonb,
               'TEST Refund', NOW(), NOW())`,
      [rpId, cpayId, wcId]
    );

    // Pass 1: should claim the failed row, hit the dead bridge, reschedule
    await runRefundPaymentRecovery(logger);
    const { rows: after1 } = await pool.query(
      `SELECT status, retry_count, next_retry_at > NOW() AS retry_in_future, error
       FROM qb_order_pipeline WHERE id = $1`,
      [rpId]
    );
    const r1 = after1[0];
    if (r1.status === "failed" && r1.retry_count === 1 && r1.retry_in_future) {
      console.log(`✅ Pass 1: claimed + rescheduled (retries=1, next_retry in future, error="${String(r1.error).slice(0, 60)}")`);
    } else {
      failures++;
      console.error(`❌ Pass 1: expected failed/retries=1/future retry — got ${JSON.stringify(r1)}`);
    }

    // Pass 2: next_retry_at now in the future → must NOT be re-claimed
    await runRefundPaymentRecovery(logger);
    const { rows: after2 } = await pool.query(
      `SELECT retry_count FROM qb_order_pipeline WHERE id = $1`,
      [rpId]
    );
    if (after2[0].retry_count === 1) {
      console.log("✅ Pass 2: future next_retry_at not re-claimed (retries still 1)");
    } else {
      failures++;
      console.error(`❌ Pass 2: retry_count moved to ${after2[0].retry_count} — claimed too early`);
    }

    // Pass 3: cap — a row at retry_count 8 must not be claimed
    await pool.query(
      `UPDATE qb_order_pipeline SET retry_count = 8, next_retry_at = NOW() - INTERVAL '1 minute' WHERE id = $1`,
      [rpId]
    );
    await runRefundPaymentRecovery(logger);
    const { rows: after3 } = await pool.query(
      `SELECT retry_count FROM qb_order_pipeline WHERE id = $1`,
      [rpId]
    );
    if (after3[0].retry_count === 8) {
      console.log("✅ Pass 3: retry cap respected (retries stay 8)");
    } else {
      failures++;
      console.error(`❌ Pass 3: capped row was claimed (retries=${after3[0].retry_count})`);
    }
  } finally {
    await pool.query(`DELETE FROM qb_order_pipeline WHERE id IN ($1, $2)`, [rpId, wcId]);
    console.log("🧹 Synthetic rows cleaned up");
  }

  console.log(failures === 0 ? "\n✅ E2E PASS" : `\n❌ E2E FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("❌ Uncaught:", e);
  process.exit(1);
});
