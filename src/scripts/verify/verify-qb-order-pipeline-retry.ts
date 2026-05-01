/**
 * Sandbox smoke test for Section 1.5.15 Phase 2.
 *
 * Validates that:
 *   1. qb_order_pipeline.next_retry_at column exists and accepts updates.
 *   2. A simulated transient error (3170 lock) routes to status='error'
 *      with a future next_retry_at, NOT directly to 'failed'.
 *   3. After exhausting retries (5 attempts), the final state is 'failed'
 *      (Phase 2 keeps `failed` as terminal — `failed_permanent` is Phase 3).
 *   4. The retry SELECT query picks up rows when next_retry_at <= NOW().
 *
 * Run against sandbox only (this script INSERTs into qb_order_pipeline):
 *   DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *     yarn medusa exec src/scripts/verify/verify-qb-order-pipeline-retry.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { decideRetry } from "../../lib/quickbooks/retry-config";

const SAFETY_GUARD = "qb_test_synthetic_v1_5_15";

export default async function verifyRetry({ container }: ExecArgs) {
  const knex = (container as any).resolve("__pg_connection__");
  const dbName: string = await knex
    .raw(`SELECT current_database() AS d`)
    .then((r: any) => r.rows[0].d);
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!dbUrl.includes("5499")) {
    console.error(
      `❌ Refusing to run — DATABASE_URL must point to sandbox (port 5499). Got db=${dbName} url=${dbUrl.slice(0, 40)}...`
    );
    process.exit(1);
  }

  let inserted = 0;
  let cleaned = 0;
  const failures: string[] = [];

  // ─── 1. Schema sanity ───────────────────────────────────────────────────
  const colExists = await knex
    .raw(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name='qb_order_pipeline' AND column_name='next_retry_at'`
    )
    .then((r: any) => r.rows.length > 0);
  if (!colExists) {
    failures.push(
      "qb_order_pipeline.next_retry_at column missing — apply migration first"
    );
    console.error(`❌ ${failures[failures.length - 1]}`);
    process.exit(1);
  }
  console.log("✓ qb_order_pipeline.next_retry_at column present");

  // ─── 2. Insert synthetic pending row ───────────────────────────────────
  const insertResult = await knex.raw(
    `INSERT INTO qb_order_pipeline
       (reference_id, reference_type, step, status, retry_count, error)
     VALUES (?, 'customer', 'customer_data_ext', 'pending', 0, ?)
     RETURNING id`,
    [SAFETY_GUARD, "synthetic-test"]
  );
  const rowId = insertResult.rows[0].id as string;
  inserted++;
  console.log(`✓ inserted synthetic row ${rowId}`);

  try {
    // ─── 3. Simulate 5 transient failures (3170 lock) ────────────────────
    const transientErr = {
      message:
        'There was an error when modifying a data extension named "Distribution Channel". QuickBooks error message: This list has been modified by another user.',
      code: "3170",
    };
    const expectedSequence = [
      { retryAfter: 1, expectStatus: "error" },
      { retryAfter: 2, expectStatus: "error" },
      { retryAfter: 3, expectStatus: "error" },
      { retryAfter: 4, expectStatus: "error" },
      { retryAfter: 5, expectStatus: "error" },
      { retryAfter: 6, expectStatus: "failed" }, // 6th attempt → exhausted
    ];

    let retriesSoFar = 0;
    for (const step of expectedSequence) {
      const decision = decideRetry({
        error: transientErr,
        retriesSoFar,
        hasNextRetryAt: true,
        hasFailedPermanent: false,
      });

      if (decision.classification.class !== "lock") {
        failures.push(
          `expected class=lock, got class=${decision.classification.class}`
        );
        break;
      }
      if (decision.newStatus !== step.expectStatus) {
        failures.push(
          `attempt ${step.retryAfter}: expected status=${step.expectStatus}, got ${decision.newStatus}`
        );
      }

      if (decision.newStatus === "error") {
        await knex.raw(
          `UPDATE qb_order_pipeline
              SET status='error', retry_count=?, error=?, next_retry_at=?, updated_at=NOW()
            WHERE id=?`,
          [decision.newRetries, transientErr.message, decision.nextRetryAt, rowId]
        );
      } else {
        await knex.raw(
          `UPDATE qb_order_pipeline
              SET status='failed', retry_count=?, error=?, failed_at=NOW(),
                  next_retry_at=NULL, updated_at=NOW()
            WHERE id=?`,
          [decision.newRetries, transientErr.message, rowId]
        );
      }
      retriesSoFar = decision.newRetries;

      const after = await knex
        .raw(
          `SELECT status, retry_count, next_retry_at FROM qb_order_pipeline WHERE id=?`,
          [rowId]
        )
        .then((r: any) => r.rows[0]);
      console.log(
        `  attempt ${step.retryAfter}: decideRetry → ${decision.newStatus} (retry ${decision.newRetries}, exhausted=${decision.exhausted}); DB: status=${after.status} retry_count=${after.retry_count} next_retry_at=${after.next_retry_at ? "set" : "null"}`
      );
    }

    // ─── 4. Verify retry SELECT picks up backoff-elapsed rows ───────────
    // Reset row to status=error with next_retry_at in the past.
    await knex.raw(
      `UPDATE qb_order_pipeline
          SET status='error', retry_count=2,
              next_retry_at = NOW() - INTERVAL '1 minute', updated_at=NOW()
        WHERE id=?`,
      [rowId]
    );
    const picked = await knex
      .raw(
        `SELECT id, COALESCE(retry_count, 0) AS retry_count
           FROM qb_order_pipeline
          WHERE step = 'customer_data_ext'
            AND (
              status = 'pending'
              OR (status = 'error' AND (next_retry_at IS NULL OR next_retry_at <= NOW()))
            )
            AND reference_id = ?`,
        [SAFETY_GUARD]
      )
      .then((r: any) => r.rows);
    if (picked.length === 0) {
      failures.push(
        "retry SELECT did not pick up status='error' row with elapsed next_retry_at"
      );
    } else if (picked[0].retry_count !== 2) {
      failures.push(
        `retry SELECT returned retry_count=${picked[0].retry_count}, expected 2`
      );
    } else {
      console.log("✓ retry SELECT picks up 'error' row with elapsed next_retry_at, retry_count carried through");
    }

    // ─── 5. Permanent error skips retries ────────────────────────────────
    const permErr = { message: "Some unknown unrecoverable error" };
    const permDecision = decideRetry({
      error: permErr,
      retriesSoFar: 0,
      hasNextRetryAt: true,
      hasFailedPermanent: false,
    });
    if (permDecision.newStatus !== "failed" || !permDecision.exhausted) {
      failures.push(
        `permanent error should go straight to 'failed' (exhausted), got status=${permDecision.newStatus} exhausted=${permDecision.exhausted}`
      );
    } else {
      console.log("✓ permanent error → failed immediately (no retry budget consumed)");
    }
  } finally {
    // ─── 6. Cleanup ─────────────────────────────────────────────────────
    const { rowCount } = await knex.raw(
      `DELETE FROM qb_order_pipeline WHERE id=?`,
      [rowId]
    );
    cleaned = rowCount ?? 0;
  }

  console.log(`\n${inserted} row inserted, ${cleaned} cleaned up.`);
  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length} failures:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\n✅ Phase 2 sandbox smoke test passed.");
}
