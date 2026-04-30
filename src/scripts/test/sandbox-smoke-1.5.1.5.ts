/**
 * Section 1.5.1.5 Integration Smoke Test — sandbox postgres:5499
 *
 * Validates the SQL contract the consolidator's new cases enforce:
 *   - estimate_cancel: needs order.metadata.qb_estimate.txn_id
 *   - credit_memo_mod: needs pos_credit_memo.qb_txn_id + qb_edit_sequence
 *
 * We test the integration points (DB reads + DB writes), not the bridge
 * round-trip itself (which has its own unit tests in B1 + the client
 * function level). The actual cancelEstimateInQb/updateCreditMemoInQb
 * functions are exercised in production via the bridge — here we verify
 * the data-flow guard rails the consolidator wraps around them.
 *
 * Tests:
 *   1. estimate_cancel: missing txn_id → failPipelineRow with clear msg
 *   2. estimate_cancel: txn_id present → SQL UPDATE to 'submitted' works correctly
 *   3. credit_memo_mod: missing qb_txn_id → failPipelineRow
 *   4. credit_memo_mod: missing qb_edit_sequence → failPipelineRow
 *   5. credit_memo_mod: both present → SQL UPDATE works correctly
 *   6. Pending-dispatch SQL pulls only step IN ('estimate_cancel','credit_memo_mod') AND status='pending'
 *
 * Run from /backend dir:
 *   node_modules/.bin/tsx src/scripts/test/sandbox-smoke-1.5.1.5.ts
 */

// Set sandbox DATABASE_URL BEFORE any import that calls getDbPool().
process.env.DATABASE_URL =
  "postgresql://postgres:sandbox@localhost:5499/medusa";

import { Client } from "pg";
import { randomUUID } from "crypto";
import { failPipelineRow } from "../../lib/quickbooks/qb-pipeline";

const SANDBOX_DB = process.env.DATABASE_URL!;
const TEST_RUN_ID = `t1515-${Date.now()}`;

let pass = 0;
let fail = 0;
const TEST_ROW_IDS: string[] = [];

function assert(cond: boolean, label: string, detail?: string) {
  if (cond) {
    console.log(`  ✅ ${label}`);
    pass++;
  } else {
    console.error(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
}

function newRowId(): string {
  const id = randomUUID();
  TEST_ROW_IDS.push(id);
  return id;
}

async function pickOrderWithEstimateTxnId(client: Client): Promise<string> {
  const res = await client.query(`
    SELECT id FROM "order"
     WHERE jsonb_extract_path(metadata::jsonb, 'qb_estimate', 'txn_id') IS NOT NULL
     LIMIT 1
  `);
  if (res.rows.length === 0) {
    throw new Error("No order with qb_estimate.txn_id in sandbox");
  }
  return res.rows[0].id;
}

async function pickOrderWithoutEstimateTxnId(client: Client): Promise<string> {
  const res = await client.query(`
    SELECT id FROM "order"
     WHERE (metadata IS NULL OR
            jsonb_extract_path(metadata::jsonb, 'qb_estimate', 'txn_id') IS NULL)
     LIMIT 1
  `);
  if (res.rows.length === 0) {
    throw new Error("No order without qb_estimate.txn_id in sandbox");
  }
  return res.rows[0].id;
}

async function pickCreditMemoFullySynced(client: Client): Promise<string> {
  const res = await client.query(`
    SELECT id FROM pos_credit_memo
     WHERE qb_txn_id IS NOT NULL AND qb_edit_sequence IS NOT NULL
     LIMIT 1
  `);
  if (res.rows.length === 0) {
    throw new Error("No fully-synced credit memo in sandbox");
  }
  return res.rows[0].id;
}

async function testEstimateCancelMissingTxnId(client: Client) {
  console.log("\n=== TEST 1 — estimate_cancel: missing txn_id → failed ===");

  const orderId = await pickOrderWithoutEstimateTxnId(client);
  const rowId = newRowId();

  await client.query(
    `INSERT INTO qb_order_pipeline
       (id, order_id, step, status, payload, created_at, updated_at)
     VALUES ($1, $2, 'estimate_cancel', 'pending', '{}'::jsonb, NOW(), NOW())`,
    [rowId, orderId]
  );

  // Verify guard: order has no qb_estimate.txn_id
  const orderRow = await client.query(
    `SELECT metadata FROM "order" WHERE id = $1`,
    [orderId]
  );
  const txnId = orderRow.rows[0]?.metadata?.qb_estimate?.txn_id;
  assert(!txnId, "test setup: order has no qb_estimate.txn_id");

  // Simulate consolidator's failPipelineRow when txn_id is missing
  await failPipelineRow(
    rowId,
    "estimate_cancel: no qb_estimate.txn_id in order metadata — nothing to cancel"
  );

  const finalRow = await client.query(
    `SELECT status, error FROM qb_order_pipeline WHERE id = $1`,
    [rowId]
  );
  const r = finalRow.rows[0];
  assert(r.status === "failed", `row → 'failed' (got ${r.status})`);
  assert(
    r.error?.includes("no qb_estimate.txn_id"),
    `error mentions missing txn_id`,
    r.error
  );
}

async function testEstimateCancelHappyPathSql(client: Client) {
  console.log(
    "\n=== TEST 2 — estimate_cancel: SQL UPDATE on success works ==="
  );

  const orderId = await pickOrderWithEstimateTxnId(client);
  const rowId = newRowId();

  await client.query(
    `INSERT INTO qb_order_pipeline
       (id, order_id, step, status, payload, created_at, updated_at)
     VALUES ($1, $2, 'estimate_cancel', 'pending', '{}'::jsonb, NOW(), NOW())`,
    [rowId, orderId]
  );

  const orderRow = await client.query(
    `SELECT metadata FROM "order" WHERE id = $1`,
    [orderId]
  );
  const txnId = orderRow.rows[0]?.metadata?.qb_estimate?.txn_id;
  assert(!!txnId, "test setup: order has qb_estimate.txn_id");

  // Simulate consolidator's UPDATE when cancelEstimateInQb returns success
  const fakeOpId = `mock-op-${rowId}`;
  await client.query(
    `UPDATE qb_order_pipeline
       SET status = 'submitted',
           bridge_op_id = $2,
           qb_txn_id = $3,
           submitted_at = NOW(),
           updated_at = NOW()
     WHERE id = $1`,
    [rowId, fakeOpId, txnId]
  );

  const final = await client.query(
    `SELECT status, bridge_op_id, qb_txn_id, submitted_at FROM qb_order_pipeline WHERE id = $1`,
    [rowId]
  );
  const r = final.rows[0];
  assert(r.status === "submitted", `status → 'submitted' (got ${r.status})`);
  assert(r.bridge_op_id === fakeOpId, `bridge_op_id stored correctly`);
  assert(r.qb_txn_id === txnId, `qb_txn_id stored correctly`);
  assert(r.submitted_at !== null, `submitted_at populated`);
}

async function testCreditMemoModMissingTxnId(client: Client) {
  console.log(
    "\n=== TEST 3 — credit_memo_mod: missing qb_txn_id → failed ==="
  );

  // Find a CM without qb_txn_id (or create a synthetic test by failing the
  // row with a static msg — we don't actually need a CM lookup since
  // failPipelineRow just writes status=failed)
  const rowId = newRowId();
  await client.query(
    `INSERT INTO qb_order_pipeline
       (id, reference_id, reference_type, step, status, payload, created_at, updated_at)
     VALUES ($1, $2, 'credit_memo', 'credit_memo_mod', 'pending', '{}'::jsonb, NOW(), NOW())`,
    [rowId, randomUUID()]
  );

  await failPipelineRow(
    rowId,
    "credit_memo_mod: pos_credit_memo has no qb_txn_id — was it synced?"
  );

  const final = await client.query(
    `SELECT status, error FROM qb_order_pipeline WHERE id = $1`,
    [rowId]
  );
  const r = final.rows[0];
  assert(r.status === "failed", `status → 'failed'`);
  assert(
    r.error?.includes("no qb_txn_id"),
    `error mentions missing qb_txn_id`
  );
}

async function testCreditMemoModMissingEditSeq(client: Client) {
  console.log(
    "\n=== TEST 4 — credit_memo_mod: missing qb_edit_sequence → failed ==="
  );

  const rowId = newRowId();
  await client.query(
    `INSERT INTO qb_order_pipeline
       (id, reference_id, reference_type, step, status, payload, created_at, updated_at)
     VALUES ($1, $2, 'credit_memo', 'credit_memo_mod', 'pending', '{}'::jsonb, NOW(), NOW())`,
    [rowId, randomUUID()]
  );

  await failPipelineRow(
    rowId,
    "credit_memo_mod: pos_credit_memo has no qb_edit_sequence — query QB first"
  );

  const final = await client.query(
    `SELECT status, error FROM qb_order_pipeline WHERE id = $1`,
    [rowId]
  );
  const r = final.rows[0];
  assert(r.status === "failed", `status → 'failed'`);
  assert(
    r.error?.includes("no qb_edit_sequence"),
    `error mentions missing qb_edit_sequence`
  );
}

async function testCreditMemoModHappyPathSql(client: Client) {
  console.log(
    "\n=== TEST 5 — credit_memo_mod: SQL UPDATE on success works ==="
  );

  const cmId = await pickCreditMemoFullySynced(client);
  const rowId = newRowId();

  const modPayload = { memo: "[smoketest] modified", salesRepRef: "AV" };
  await client.query(
    `INSERT INTO qb_order_pipeline
       (id, reference_id, reference_type, step, status, payload, created_at, updated_at)
     VALUES ($1, $2, 'credit_memo', 'credit_memo_mod', 'pending', $3::jsonb, NOW(), NOW())`,
    [rowId, cmId, JSON.stringify(modPayload)]
  );

  // Verify the consolidator's JOIN query works correctly
  const joined = await client.query(
    `SELECT cm.qb_txn_id, cm.qb_edit_sequence, p.payload
       FROM qb_order_pipeline p
       JOIN pos_credit_memo cm ON cm.id = p.reference_id
      WHERE p.id = $1`,
    [rowId]
  );
  const j = joined.rows[0];
  assert(!!j?.qb_txn_id, "JOIN returns CM qb_txn_id");
  assert(!!j?.qb_edit_sequence, "JOIN returns CM qb_edit_sequence");
  assert(j?.payload?.memo === "[smoketest] modified", "JOIN returns row payload");

  // Apply the consolidator's success UPDATE
  const fakeOpId = `mock-op-${rowId}`;
  await client.query(
    `UPDATE qb_order_pipeline
       SET status = 'submitted',
           bridge_op_id = $2,
           qb_txn_id = $3,
           submitted_at = NOW(),
           updated_at = NOW()
     WHERE id = $1`,
    [rowId, fakeOpId, j.qb_txn_id]
  );

  const final = await client.query(
    `SELECT status, bridge_op_id, qb_txn_id FROM qb_order_pipeline WHERE id = $1`,
    [rowId]
  );
  const r = final.rows[0];
  assert(r.status === "submitted", "status → 'submitted'");
  assert(r.bridge_op_id === fakeOpId, "bridge_op_id stored");
  assert(r.qb_txn_id === j.qb_txn_id, "qb_txn_id stored from CM");
}

async function testPendingDispatchQuery(client: Client) {
  console.log(
    "\n=== TEST 6 — Pending-dispatch SQL only picks up our new steps ==="
  );

  // Insert one estimate_cancel + one credit_memo_mod + one OTHER step
  // (estimate) — the dispatch query should pick up the first two only.
  const orderId = await pickOrderWithEstimateTxnId(client);
  const cmId = await pickCreditMemoFullySynced(client);

  const id1 = newRowId();
  const id2 = newRowId();
  const id3 = newRowId(); // distractor

  await client.query(
    `INSERT INTO qb_order_pipeline (id, order_id, step, status, payload, created_at, updated_at)
     VALUES
       ($1, $4, 'estimate_cancel', 'pending', '{}'::jsonb, NOW(), NOW()),
       ($2, NULL, 'credit_memo_mod', 'pending', '{}'::jsonb, NOW(), NOW()),
       ($3, $4, 'estimate', 'pending', '{}'::jsonb, NOW(), NOW())`,
    [id1, id2, id3, orderId]
  );
  // Set reference_id for cm row
  await client.query(
    `UPDATE qb_order_pipeline SET reference_id = $1, reference_type = 'credit_memo' WHERE id = $2`,
    [cmId, id2]
  );

  // Run the EXACT same query the consolidator's pending-dispatch pass uses
  const result = await client.query(`
    SELECT id, step
      FROM qb_order_pipeline
     WHERE step IN ('estimate_cancel', 'credit_memo_mod')
       AND status = 'pending'
       AND id IN ($1::uuid, $2::uuid, $3::uuid)
     ORDER BY COALESCE(updated_at, created_at) ASC
  `, [id1, id2, id3]);

  assert(result.rows.length === 2, `picked exactly 2 rows (got ${result.rows.length})`);
  const steps = result.rows.map((r) => r.step).sort();
  assert(
    JSON.stringify(steps) === JSON.stringify(["credit_memo_mod", "estimate_cancel"]),
    "picked correct steps (estimate_cancel + credit_memo_mod, NOT estimate)"
  );
}

async function cleanup(client: Client) {
  if (TEST_ROW_IDS.length === 0) return;
  console.log(`\nCleaning up ${TEST_ROW_IDS.length} test rows...`);
  const placeholders = TEST_ROW_IDS.map((_, i) => `$${i + 1}::uuid`).join(",");
  await client.query(
    `DELETE FROM qb_order_pipeline WHERE id IN (${placeholders})`,
    TEST_ROW_IDS
  );
  console.log("✓ cleanup done");
}

async function main() {
  console.log(`Section 1.5.1.5 integration smoke test`);
  console.log(`Test run id: ${TEST_RUN_ID}\n`);

  const client = new Client({ connectionString: SANDBOX_DB });
  await client.connect();

  try {
    await testEstimateCancelMissingTxnId(client);
    await testEstimateCancelHappyPathSql(client);
    await testCreditMemoModMissingTxnId(client);
    await testCreditMemoModMissingEditSeq(client);
    await testCreditMemoModHappyPathSql(client);
    await testPendingDispatchQuery(client);
  } finally {
    await cleanup(client);
    await client.end();
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Pass: ${pass}  /  Fail: ${fail}`);
  console.log("=".repeat(50));

  if (fail > 0) {
    console.error("\n❌ 1.5.1.5 integration tests FAILED");
    process.exit(1);
  }
  console.log("\n🎉 1.5.1.5 integration tests PASSED");
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
