/**
 * verify-refund-payment-retry.ts
 *
 * Verifies the refund_payment retry fix (recovery pass now claims 'failed'
 * rows with a due next_retry_at, not just orphaned 'waiting' rows).
 *
 * Read-only against whatever DB the env points at:
 *  1. The new claim query is valid SQL and runs (EXPLAIN + live SELECT).
 *  2. No refund_payment row is currently stranded: failed + write_check
 *     confirmed + due retry but unclaimable (would indicate a query bug).
 *  3. Prints any rows the recovery pass would claim right now.
 *
 * Run: cd backend && env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *        ./node_modules/.bin/medusa exec ./src/scripts/verify/verify-refund-payment-retry.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";

const CLAIM_SQL = `
  SELECT rp.id, rp.reference_id, rp.status, rp.retry_count, rp.next_retry_at,
         rp.medusa_ref_number, wc.qb_txn_id AS check_txn_id
  FROM qb_order_pipeline rp
  JOIN qb_order_pipeline wc ON wc.id = rp.depends_on
  WHERE rp.step   = 'refund_payment'
    AND wc.step   = 'write_check'
    AND wc.status = 'confirmed'
    AND wc.qb_txn_id IS NOT NULL
    AND (
      rp.status = 'waiting'
      OR (rp.status = 'failed'
          AND rp.next_retry_at IS NOT NULL
          AND rp.next_retry_at <= NOW()
          AND COALESCE(rp.retry_count, 0) < 8)
    )
`;

export default async function verifyRefundPaymentRetry({ container }: ExecArgs) {
  const pool = container.resolve("__pg_connection__") as any;
  let failures = 0;

  // 1. Claim query parses and runs
  try {
    await pool.raw(`EXPLAIN ${CLAIM_SQL}`);
    console.log("✅ 1. Recovery claim query is valid SQL");
  } catch (err: any) {
    failures++;
    console.error(`❌ 1. Claim query invalid: ${err.message}`);
  }

  // 2. Rows the recovery pass would claim right now
  const { rows: claimable } = await pool.raw(CLAIM_SQL);
  console.log(`ℹ️  2. Rows claimable by recovery right now: ${claimable.length}`);
  for (const r of claimable) {
    console.log(
      `     - ${r.medusa_ref_number ?? r.id} status=${r.status} retries=${r.retry_count ?? 0}`
    );
  }

  // 3. Stranded detector: failed refund_payment rows with a confirmed
  //    write_check that the claim query does NOT cover (should only be rows
  //    past the retry cap or QB hard-rejects without next_retry_at — listed
  //    for manual triage, not a code failure unless marked UNEXPECTED).
  const { rows: stranded } = await pool.raw(`
    SELECT rp.id, rp.medusa_ref_number, rp.retry_count, rp.next_retry_at,
           left(coalesce(rp.error, ''), 80) AS error
    FROM qb_order_pipeline rp
    JOIN qb_order_pipeline wc ON wc.id = rp.depends_on
    WHERE rp.step = 'refund_payment' AND rp.status = 'failed'
      AND wc.step = 'write_check' AND wc.status = 'confirmed'
      AND wc.qb_txn_id IS NOT NULL
      AND NOT (rp.next_retry_at IS NOT NULL AND rp.next_retry_at <= NOW()
               AND COALESCE(rp.retry_count, 0) < 8)
  `);
  if (stranded.length === 0) {
    console.log("✅ 3. No failed refund_payment rows outside the retry envelope");
  } else {
    for (const r of stranded) {
      const capped = Number(r.retry_count ?? 0) >= 8;
      const hardFail = r.next_retry_at === null;
      const expected = capped || hardFail;
      if (!expected) failures++;
      console.log(
        `${expected ? "ℹ️ " : "❌"} 3. ${r.medusa_ref_number ?? r.id}: retries=${r.retry_count ?? 0} next_retry=${r.next_retry_at} error="${r.error}" ${expected ? "(manual triage — expected)" : "(UNEXPECTED: future next_retry_at inside cap)"}`
      );
    }
  }

  console.log(
    failures === 0
      ? "\n✅ VERIFY PASS — refund_payment retry wiring is consistent"
      : `\n❌ VERIFY FAIL — ${failures} problem(s)`
  );
  if (failures > 0) process.exit(1);
}
