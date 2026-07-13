/**
 * SANDBOX-ONLY. Verifies the payment_method_change retry-plumbing fix
 * (2026-07-13, commit bf30b566): the step was missing from all three lists
 * the consolidator uses to decide what to retry, so a failed row (stale
 * EditSequence, bridge timeout, whatever) got `next_retry_at` set by the
 * generic submitted-row poller but was never read again — stuck forever.
 *
 * Checks, against REAL consolidator functions (no reimplementation):
 *   1. dispatch-pass.ts's failed-row query now claims a 'failed' row with
 *      next_retry_at in the past, and resubmit-by-step.ts's new case runs
 *      the real read/resolve/bridge-call path (QB_BRIDGE_URL is disabled in
 *      sandbox, so the bridge call fails at the network boundary — this is
 *      expected and proves nothing here can touch real QuickBooks).
 *   2. recovery-pass.ts's IDEMPOTENT_REDISPATCH_STEPS now resets an orphaned
 *      'processing' row (crashed mid-dispatch, no bridge_op_id, >8min) back
 *      to 'pending'.
 *
 * Refuses to run unless DATABASE_URL points at the sandbox Postgres (:5499).
 * Inserts ONLY synthetic qb_order_pipeline rows (never touches
 * customer_payment) and deletes them in a `finally` regardless of outcome.
 *
 * Usage (sandbox):
 *   env DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa' \
 *       QB_BRIDGE_URL='http://localhost:9999/disabled' QB_BRIDGE_DISABLED=true \
 *     npx medusa exec ./src/scripts/verify/verify-payment-method-change-retry.ts
 */
import { runPendingDispatchPass } from "../../lib/quickbooks/consolidator/dispatch-pass";
import { runOrphanedProcessingRecovery } from "../../lib/quickbooks/consolidator/recovery-pass";

// Real sandbox row: credit_card/visa, qb_txn_id on file, not SR-embedded.
const TEST_PAYMENT_ID = "cpay_01KX43VZWQSXY07PRJAC8GZ1MJ";

// The step list as it existed BEFORE this fix (dispatch-pass.ts) — used only
// to prove the counterfactual: this exact row would NOT have been claimed.
const PRE_FIX_DISPATCH_STEPS = [
  "estimate_cancel",
  "estimate_deactivate",
  "credit_memo_mod",
  "transfer_customer",
  "transfer_payment",
  "payment_txndate_change",
  "refund_check_mod",
  "refund_payment_txndate_change",
  "estimate",
  "sales_order",
  "so_close",
  "so_reopen",
  "sales_receipt",
  "invoice",
  "invoice_update",
  "sales_receipt_update",
  "credit_memo",
  "void_credit_memo",
  "void_invoice",
  "void_sales_order",
  "void_sales_receipt",
  "void_check",
  "payment",
  "apply_payment",
  "inventory_adjustment",
  "void_inventory_adjustment",
];

export default async function verifyPaymentMethodChangeRetry({
  container,
}: {
  container: any;
}) {
  const log = (m: string) => console.log(`[verify-pmc-retry] ${m}`);
  let failures = 0;

  if (!process.env.DATABASE_URL?.includes("5499")) {
    log(
      "❌ Refusing to run — DATABASE_URL does not point at sandbox (:5499). Aborting."
    );
    process.exitCode = 1;
    return;
  }

  const pg = container.resolve("__pg_connection__") as any;
  const fakeLogger = {
    info: (m: string) => log(`  [pass] ${m}`),
    warn: (m: string) => log(`  [pass] ⚠️ ${m}`),
  };
  const rowIds: string[] = [];

  try {
    // ── Check 1: dispatch-pass claims a stuck failed row ──────────────────
    const insertFailed = await pg.raw(
      `INSERT INTO qb_order_pipeline
         (order_id, reference_id, reference_type, step, status, retry_count, next_retry_at, error, created_at, updated_at)
       VALUES (NULL, ?, 'customer_payment', 'payment_method_change', 'failed', 1, NOW() - INTERVAL '1 minute', 'synthetic: prior stuck failure', NOW(), NOW())
       RETURNING id`,
      [TEST_PAYMENT_ID]
    );
    const failedRowId = insertFailed.rows[0].id as string;
    rowIds.push(failedRowId);
    log(`Seeded failed row ${failedRowId} (next_retry_at in the past)`);

    const oldListMatch = await pg.raw(
      `SELECT 1 FROM qb_order_pipeline WHERE id = ? AND step = ANY(?)`,
      [failedRowId, PRE_FIX_DISPATCH_STEPS]
    );
    if (oldListMatch.rows.length > 0) {
      failures++;
      log(
        `❌ Counterfactual failed — the PRE-FIX step list unexpectedly matched (bad test fixture)`
      );
    } else {
      log(
        `✅ Counterfactual confirmed: the PRE-FIX step list would NOT have claimed this row (this is the bug)`
      );
    }

    await runPendingDispatchPass(container, fakeLogger);

    const { rows: afterDispatch } = await pg.raw(
      `SELECT status, error, updated_at FROM qb_order_pipeline WHERE id = ?`,
      [failedRowId]
    );
    const after = afterDispatch[0];
    if (after.status === "failed" && after.error === "synthetic: prior stuck failure") {
      failures++;
      log(
        `❌ Row ${failedRowId} was NOT claimed by dispatch-pass — still shows the original stuck state`
      );
    } else {
      log(
        `✅ Row ${failedRowId} WAS claimed and run through resubmitByStep. End state: status=${after.status}, error=${after.error ?? "(none)"}`
      );
    }

    // ── Check 2: recovery-pass resets an orphaned 'processing' row ────────
    const insertOrphan = await pg.raw(
      `INSERT INTO qb_order_pipeline
         (order_id, reference_id, reference_type, step, status, retry_count, bridge_op_id, created_at, updated_at)
       VALUES (NULL, ?, 'customer_payment', 'payment_method_change', 'processing', 0, NULL, NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '10 minutes')
       RETURNING id`,
      [TEST_PAYMENT_ID]
    );
    const orphanRowId = insertOrphan.rows[0].id as string;
    rowIds.push(orphanRowId);
    log(
      `Seeded orphaned processing row ${orphanRowId} (updated_at 10min ago, no bridge_op_id)`
    );

    await runOrphanedProcessingRecovery(fakeLogger);

    const { rows: afterRecovery } = await pg.raw(
      `SELECT status, retry_count, next_retry_at FROM qb_order_pipeline WHERE id = ?`,
      [orphanRowId]
    );
    const recovered = afterRecovery[0];
    if (recovered.status === "pending" && recovered.next_retry_at) {
      log(
        `✅ Orphaned processing row ${orphanRowId} was reset to 'pending' by recovery-pass (retry_count=${recovered.retry_count})`
      );
    } else {
      failures++;
      log(
        `❌ Orphaned processing row ${orphanRowId} was NOT reset — status=${recovered.status}`
      );
    }
  } finally {
    for (const id of rowIds) {
      await pg.raw(`DELETE FROM qb_order_pipeline WHERE id = ?`, [id]);
    }
    if (rowIds.length > 0) {
      log(`Cleaned up ${rowIds.length} synthetic row(s)`);
    }
  }

  log(`\n──── Summary ────`);
  log(failures === 0 ? `✅ ALL PASS` : `❌ ${failures} FAILURE(S)`);
  if (failures > 0) process.exitCode = 1;
}
