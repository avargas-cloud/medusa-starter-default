/**
 * verify-estimate-sequential-saves.ts
 *
 * Simulates the concurrent-save scenario that caused 5 duplicate rows in the
 * qb_order_pipeline "Sales Pipeline" (Order 1458 / TxnID 1C1251-1776781804)
 * and verifies:
 *
 *   1. writePipelineRow idempotency — repeated writes with the same
 *      (order_id, step, status) always UPDATE, never INSERT.
 *
 *   2. coalesceIfInFlight behavior — a save while a prior op is 'submitted'
 *      marks next_payload on the existing row instead of creating a new one.
 *
 *   3. Terminal-state idempotency — two serialized callbacks both ending
 *      in 'failed' or 'confirmed' UPDATE the same row instead of INSERTing
 *      a duplicate.
 *
 * Run:
 *   npx tsx src/scripts/verify/verify-estimate-sequential-saves.ts
 *
 * Zero side effects on real data: uses synthetic order_ids prefixed with
 * "verify_estimate_sequential_" and cleans up at the end.
 */
import { getDbPool } from "../../api/utils/db-pool";
import {
  writePipelineRow,
  coalesceIfInFlight,
  claimAndResetForResubmit,
} from "../../lib/quickbooks/qb-pipeline";

const PREFIX = "verify_estimate_sequential_";

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`✅ ${name}`);
    passed++;
  } else {
    console.error(`❌ ${name}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

async function countRows(orderId: string, step: string): Promise<number> {
  const pool = getDbPool();
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM qb_order_pipeline WHERE order_id = $1 AND step = $2`,
    [orderId, step]
  );
  return rows[0]?.n ?? 0;
}

async function getStatus(orderId: string, step: string): Promise<string[]> {
  const pool = getDbPool();
  const { rows } = await pool.query(
    `SELECT status FROM qb_order_pipeline WHERE order_id = $1 AND step = $2 ORDER BY created_at ASC`,
    [orderId, step]
  );
  return rows.map((r) => r.status as string);
}

async function cleanup(): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `DELETE FROM qb_order_pipeline WHERE order_id LIKE $1`,
    [`${PREFIX}%`]
  );
}

async function run(): Promise<void> {
  await cleanup();

  // ────────────────────────────────────────────────────────────────────────
  // Test 1: Rapid pending→failed→failed writes do NOT duplicate.
  //   Simulates the Order 1458 scenario: user saves twice quickly, both
  //   bridge calls fail with 530. Second write of 'failed' should UPDATE
  //   the existing row, not INSERT a duplicate.
  // ────────────────────────────────────────────────────────────────────────
  {
    const orderId = `${PREFIX}1`;
    await writePipelineRow({ orderId, step: "estimate", status: "pending", qbTxnId: "TXN-A" });
    await writePipelineRow({ orderId, step: "estimate", status: "failed", qbTxnId: "TXN-A", error: "Bridge 530" });
    // Second callback also ends in 'failed' — previously would INSERT
    await writePipelineRow({ orderId, step: "estimate", status: "failed", qbTxnId: "TXN-A", error: "Bridge 530 again" });

    const n = await countRows(orderId, "estimate");
    assert("Test 1: pending→failed→failed stays at 1 row", n === 1, `got ${n}`);

    const statuses = await getStatus(orderId, "estimate");
    assert("Test 1: row ends in 'failed' status", statuses[0] === "failed");
  }

  // ────────────────────────────────────────────────────────────────────────
  // Test 2: Reactivate from failed, then fail again — still 1 row.
  // ────────────────────────────────────────────────────────────────────────
  {
    const orderId = `${PREFIX}2`;
    await writePipelineRow({ orderId, step: "estimate", status: "pending", qbTxnId: "TXN-B" });
    await writePipelineRow({ orderId, step: "estimate", status: "failed", qbTxnId: "TXN-B", error: "first fail" });
    // User retries: reactivation from failed → pending
    await writePipelineRow({ orderId, step: "estimate", status: "pending", qbTxnId: "TXN-B" });
    await writePipelineRow({ orderId, step: "estimate", status: "failed", qbTxnId: "TXN-B", error: "second fail" });

    const n = await countRows(orderId, "estimate");
    assert("Test 2: reactivate→fail cycle stays at 1 row", n === 1, `got ${n}`);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Test 3: Two serialized callbacks — both confirmed (simulates race
  // where consolidator and handler both try to confirm).
  // ────────────────────────────────────────────────────────────────────────
  {
    const orderId = `${PREFIX}3`;
    await writePipelineRow({ orderId, step: "estimate", status: "pending", qbTxnId: "TXN-C" });
    await writePipelineRow({ orderId, step: "estimate", status: "submitted", bridgeOpId: "op-123", qbTxnId: "TXN-C" });
    await writePipelineRow({ orderId, step: "estimate", status: "confirmed", qbTxnId: "TXN-C", qbRefNumber: "E18024XXX" });
    // Second confirm race
    await writePipelineRow({ orderId, step: "estimate", status: "confirmed", qbTxnId: "TXN-C", qbRefNumber: "E18024XXX" });

    const n = await countRows(orderId, "estimate");
    assert("Test 3: duplicate confirm stays at 1 row", n === 1, `got ${n}`);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Test 4: coalesceIfInFlight — save 2 while save 1 is 'submitted'
  // should mark next_payload, not create a new row.
  // ────────────────────────────────────────────────────────────────────────
  {
    const orderId = `${PREFIX}4`;
    await writePipelineRow({ orderId, step: "estimate", status: "pending", qbTxnId: "TXN-D" });
    await writePipelineRow({ orderId, step: "estimate", status: "submitted", bridgeOpId: "op-D-1", qbTxnId: "TXN-D" });

    const coalesced = await coalesceIfInFlight(orderId, null, "estimate");
    assert("Test 4: coalesceIfInFlight returns true when submitted", coalesced === true);

    const n = await countRows(orderId, "estimate");
    assert("Test 4: no new row after coalesce", n === 1, `got ${n}`);

    const pool = getDbPool();
    const { rows } = await pool.query(
      `SELECT next_payload FROM qb_order_pipeline WHERE order_id = $1 AND step = 'estimate'`,
      [orderId]
    );
    assert("Test 4: next_payload set on the row", rows[0]?.next_payload !== null);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Test 5: coalesceIfInFlight returns false when no submitted row exists.
  // ────────────────────────────────────────────────────────────────────────
  {
    const orderId = `${PREFIX}5`;
    await writePipelineRow({ orderId, step: "estimate", status: "failed", qbTxnId: "TXN-E", error: "boom" });

    const coalesced = await coalesceIfInFlight(orderId, null, "estimate");
    assert("Test 5: coalesceIfInFlight returns false when no submitted row", coalesced === false);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Test 6: claimAndResetForResubmit — after confirm, if next_payload was
  // set, resets to pending and returns true.
  // ────────────────────────────────────────────────────────────────────────
  {
    const orderId = `${PREFIX}6`;
    await writePipelineRow({ orderId, step: "estimate", status: "pending", qbTxnId: "TXN-F" });
    await writePipelineRow({ orderId, step: "estimate", status: "submitted", bridgeOpId: "op-F-1", qbTxnId: "TXN-F" });
    await coalesceIfInFlight(orderId, null, "estimate"); // set next_payload

    // Simulate confirmation
    const pool = getDbPool();
    const { rows: rowsBefore } = await pool.query(
      `SELECT id FROM qb_order_pipeline WHERE order_id = $1 AND step = 'estimate'`,
      [orderId]
    );
    const rowId = rowsBefore[0].id as string;

    // Update to confirmed (simulate consolidator)
    await pool.query(
      `UPDATE qb_order_pipeline SET status = 'confirmed', confirmed_at = NOW() WHERE id = $1`,
      [rowId]
    );

    const claimed = await claimAndResetForResubmit(rowId);
    assert("Test 6: claimAndResetForResubmit returns true", claimed === true);

    const { rows: after } = await pool.query(
      `SELECT status, next_payload FROM qb_order_pipeline WHERE id = $1`,
      [rowId]
    );
    assert("Test 6: row reset to pending", after[0].status === "pending");
    assert("Test 6: next_payload cleared", after[0].next_payload === null);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Test 7a: Same pipeline idempotency, but for step='sales_order'.
  // Proves the guard applies to SO MOD races, not just estimate.
  // ────────────────────────────────────────────────────────────────────────
  {
    const orderId = `${PREFIX}7a`;
    await writePipelineRow({ orderId, step: "sales_order", status: "pending", qbTxnId: "SO-TXN-1" });
    await writePipelineRow({ orderId, step: "sales_order", status: "failed", qbTxnId: "SO-TXN-1", error: "SO bridge fail 1" });
    await writePipelineRow({ orderId, step: "sales_order", status: "failed", qbTxnId: "SO-TXN-1", error: "SO bridge fail 2" });
    const n = await countRows(orderId, "sales_order");
    assert("Test 7a: SO terminal-state idempotency — 1 row after repeated failures", n === 1, `got ${n}`);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Test 7b: coalesceIfInFlight for sales_order step.
  // ────────────────────────────────────────────────────────────────────────
  {
    const orderId = `${PREFIX}7b`;
    await writePipelineRow({ orderId, step: "sales_order", status: "pending", qbTxnId: "SO-TXN-2" });
    await writePipelineRow({ orderId, step: "sales_order", status: "submitted", bridgeOpId: "op-SO-1", qbTxnId: "SO-TXN-2" });
    const coalesced = await coalesceIfInFlight(orderId, null, "sales_order");
    assert("Test 7b: coalesceIfInFlight for sales_order returns true", coalesced === true);
    const n = await countRows(orderId, "sales_order");
    assert("Test 7b: SO no new row after coalesce", n === 1, `got ${n}`);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Test 7c: SO confirmed→pending reactivation preserves qb_txn_id.
  // Critical: retry MUST preserve txn_id so MOD path runs, not CREATE.
  // ────────────────────────────────────────────────────────────────────────
  {
    const orderId = `${PREFIX}7c`;
    const pool = getDbPool();
    await pool.query(
      `INSERT INTO qb_order_pipeline (order_id, step, status, qb_txn_id, qb_ref_number, retry_count, created_at, updated_at, failed_at)
       VALUES ($1, 'sales_order', 'failed', 'SO-TXN-3', 'S12345', 1, NOW(), NOW(), NOW())`,
      [orderId]
    );
    // Simulate retry reactivation via writePipelineRow(pending)
    await writePipelineRow({ orderId, step: "sales_order", status: "pending", qbTxnId: "SO-TXN-3", qbRefNumber: "S12345" });
    const { rows } = await pool.query(
      `SELECT qb_txn_id, qb_ref_number, status FROM qb_order_pipeline WHERE order_id = $1 AND step = 'sales_order'`,
      [orderId]
    );
    assert("Test 7c: qb_txn_id preserved on reactivate", rows[0]?.qb_txn_id === "SO-TXN-3");
    assert("Test 7c: qb_ref_number preserved on reactivate", rows[0]?.qb_ref_number === "S12345");
    assert("Test 7c: status flipped to pending", rows[0]?.status === "pending");
  }

  // ────────────────────────────────────────────────────────────────────────
  // Test 7: THE bug fix — confirm that the terminal-state idempotency guard
  // actually kicks in when there's no 'pending' or 'submitted' row to match.
  // (Direct row state manipulation to isolate the bug.)
  // ────────────────────────────────────────────────────────────────────────
  {
    const orderId = `${PREFIX}7`;
    const pool = getDbPool();
    // Seed a 'failed' row directly (no pending/submitted anywhere in history)
    await pool.query(
      `INSERT INTO qb_order_pipeline (order_id, step, status, qb_txn_id, error, retry_count, created_at, updated_at)
       VALUES ($1, 'estimate', 'failed', 'TXN-G', 'first fail', 0, NOW(), NOW())`,
      [orderId]
    );

    // Now a second failure — before the fix, this would INSERT because
    // Query 3 only matched 'pending'/'submitted'. After the fix, the
    // terminal-state fallback matches the 'failed' row and UPDATEs it.
    await writePipelineRow({
      orderId,
      step: "estimate",
      status: "failed",
      qbTxnId: "TXN-G",
      error: "second fail — SHOULD NOT DUPLICATE",
    });

    const n = await countRows(orderId, "estimate");
    assert("Test 7: terminal-state idempotency guard prevents INSERT", n === 1, `got ${n}`);

    const { rows: errRows } = await pool.query(
      `SELECT error FROM qb_order_pipeline WHERE order_id = $1 AND step = 'estimate'`,
      [orderId]
    );
    assert(
      "Test 7: error message was updated to the latest",
      errRows[0].error === "second fail — SHOULD NOT DUPLICATE"
    );
  }

  // ────────────────────────────────────────────────────────────────────────
  // Test 8: HIGH-1 defense — if two rows somehow exist for the same
  // (order_id, step), the terminal-state guard must NOT clobber both.
  // It should update ONLY the most recent one (LIMIT 1 via subquery).
  // ────────────────────────────────────────────────────────────────────────
  {
    const orderId = `${PREFIX}8`;
    const pool = getDbPool();

    // Seed two rows manually — simulates invariant violation (manual insert, broken migration)
    const { rows: olderRows } = await pool.query(
      `INSERT INTO qb_order_pipeline (order_id, step, status, qb_txn_id, error, retry_count, created_at, updated_at)
       VALUES ($1, 'estimate', 'failed', 'OLD-TXN', 'OLDER ERROR', 1, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour')
       RETURNING id`,
      [orderId]
    );
    const { rows: newerRows } = await pool.query(
      `INSERT INTO qb_order_pipeline (order_id, step, status, qb_txn_id, error, retry_count, created_at, updated_at)
       VALUES ($1, 'estimate', 'failed', 'NEW-TXN', 'NEWER ERROR', 0, NOW(), NOW())
       RETURNING id`,
      [orderId]
    );
    const olderId = olderRows[0].id;
    const newerId = newerRows[0].id;

    // Now call writePipelineRow(failed) — terminal-state guard should match and
    // ONLY update the NEWER row (ORDER BY updated_at DESC LIMIT 1 in subquery).
    await writePipelineRow({
      orderId,
      step: "estimate",
      status: "failed",
      qbTxnId: "NEW-TXN",
      error: "LATEST ERROR",
    });

    const { rows: olderCheck } = await pool.query(
      `SELECT error FROM qb_order_pipeline WHERE id = $1`,
      [olderId]
    );
    const { rows: newerCheck } = await pool.query(
      `SELECT error FROM qb_order_pipeline WHERE id = $1`,
      [newerId]
    );

    assert(
      "Test 8: HIGH-1 — older row untouched (its error preserved)",
      olderCheck[0].error === "OLDER ERROR",
      `got: ${olderCheck[0].error}`
    );
    assert(
      "Test 8: HIGH-1 — newer row updated (its error is latest)",
      newerCheck[0].error === "LATEST ERROR",
      `got: ${newerCheck[0].error}`
    );
  }

  // ────────────────────────────────────────────────────────────────────────
  // Test 9: Cross-step isolation — writing to step='estimate' must not
  // affect step='sales_order' rows for the same order.
  // ────────────────────────────────────────────────────────────────────────
  {
    const orderId = `${PREFIX}9`;
    await writePipelineRow({ orderId, step: "estimate", status: "pending", qbTxnId: "E-TXN" });
    await writePipelineRow({ orderId, step: "sales_order", status: "confirmed", qbTxnId: "S-TXN", qbRefNumber: "S999" });

    // Now fail the estimate — must not touch sales_order
    await writePipelineRow({ orderId, step: "estimate", status: "failed", qbTxnId: "E-TXN", error: "only estimate fails" });

    const pool = getDbPool();
    const { rows: estRows } = await pool.query(
      `SELECT status, error FROM qb_order_pipeline WHERE order_id = $1 AND step = 'estimate'`,
      [orderId]
    );
    const { rows: soRows } = await pool.query(
      `SELECT status, error FROM qb_order_pipeline WHERE order_id = $1 AND step = 'sales_order'`,
      [orderId]
    );

    assert("Test 9: estimate → failed", estRows[0]?.status === "failed");
    assert("Test 9: sales_order row untouched (still confirmed)", soRows[0]?.status === "confirmed");
    assert("Test 9: sales_order error is null (untouched)", soRows[0]?.error === null);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Test 10: reference_id isolation — payment rows use reference_id, not
  // order_id. Writing an estimate row for the same order_id must not
  // affect payment rows keyed by reference_id.
  // ────────────────────────────────────────────────────────────────────────
  {
    const orderId = `${PREFIX}10`;
    const refId = `${PREFIX}10-pay`;
    const pool = getDbPool();

    // Seed a payment row keyed by reference_id (no order_id)
    await pool.query(
      `INSERT INTO qb_order_pipeline (reference_id, reference_type, step, status, qb_txn_id, retry_count, created_at, updated_at)
       VALUES ($1, 'customer_payment', 'payment', 'confirmed', 'PAY-TXN', 0, NOW(), NOW())`,
      [refId]
    );

    await writePipelineRow({ orderId, step: "estimate", status: "pending", qbTxnId: "E-TXN" });
    await writePipelineRow({ orderId, step: "estimate", status: "failed", qbTxnId: "E-TXN", error: "fail" });

    const { rows: payRows } = await pool.query(
      `SELECT status FROM qb_order_pipeline WHERE reference_id = $1 AND step = 'payment'`,
      [refId]
    );
    assert("Test 10: reference_id-keyed payment row untouched", payRows[0]?.status === "confirmed");
  }

  await cleanup();

  console.log("");
  console.log(`──────────────────────────────────────────────`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`──────────────────────────────────────────────`);

  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
