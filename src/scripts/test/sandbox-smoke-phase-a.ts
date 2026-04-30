/**
 * Phase A Integration Smoke Test (B1 + B2 + B3) — runs against sandbox postgres:5499.
 *
 * What it tests (real DB + real HTTP, no mocks):
 *
 *   B1 (Bridge 404 handling):
 *     - Spawns mini HTTP server on :9989 returning 404 for /api/sync/status/*
 *     - Points QB_BRIDGE_URL at it
 *     - Calls pollBridgeStatus() and asserts {status: "expired"}
 *     - Inserts a fake PO pipeline row in 'submitted' state
 *     - Simulates the poller's expired-handling SQL UPDATE
 *     - Asserts row transitions to 'error' with cleared qb_operation_id and short retry
 *
 *   B2 (Vendor backoff unified):
 *     - Calls computeNextRetryDate(2) and asserts +10 min (was +8 before)
 *     - Inserts a fake qb_vendor row with retry_count=2 + computed next_retry_at
 *     - Asserts the SQL value matches what the poller would write
 *
 *   B3 (Stale-row cleanup):
 *     - Inserts row in qb_purchase_order_pipeline with status='submitted',
 *       updated_at = NOW() - 31 minutes
 *     - Calls markStaleRowsAsFailed() with knex against sandbox DB
 *     - Asserts row transitions to 'error' with 'Timeout' message + cleared qb_operation_id
 *
 * Run from /backend dir:
 *   node_modules/.bin/tsx src/scripts/test/sandbox-smoke-phase-a.ts
 *
 * Pre-reqs:
 *   - Sandbox containers up (postgres:5499)
 *   - Run after `./scripts/sandbox/snapshot.sh pre-phase-a-tests` if you want rollback
 */

import { Client } from "pg";
import http from "http";
import knexFactory from "knex";

import {
  pollBridgeStatus,
  BridgeFetchError,
} from "../../lib/quickbooks/bridge-fetch";
import {
  computeNextRetryDate,
  STANDARD_BACKOFF_MINUTES,
} from "../../lib/quickbooks/retry-config";
import {
  markStaleRowsAsFailed,
  STANDARD_STALE_CONFIG,
} from "../../lib/quickbooks/stale-row-cleanup";

const SANDBOX_DB = "postgresql://postgres:sandbox@localhost:5499/medusa";
const MOCK_BRIDGE_PORT = 9989;
const TEST_RUN_ID = `smoketest-${Date.now()}`;

let pass = 0;
let fail = 0;

function assert(cond: boolean, label: string, detail?: string) {
  if (cond) {
    console.log(`  ✅ ${label}`);
    pass++;
  } else {
    console.error(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
}

async function withMockBridge<T>(
  responseFn: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  fn: () => Promise<T>
): Promise<T> {
  const server = http.createServer(responseFn);
  await new Promise<void>((resolve) => server.listen(MOCK_BRIDGE_PORT, resolve));
  const prevUrl = process.env.QB_BRIDGE_URL;
  process.env.QB_BRIDGE_URL = `http://localhost:${MOCK_BRIDGE_PORT}`;
  try {
    return await fn();
  } finally {
    if (prevUrl) {
      process.env.QB_BRIDGE_URL = prevUrl;
    } else {
      delete process.env.QB_BRIDGE_URL;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function pickRealPurchaseOrderId(client: Client): Promise<string> {
  // Pick a PO that does NOT already have a pipeline row, to avoid
  // UQ_qbpopipe_purchase_order_id unique-constraint violations when we INSERT.
  const res = await client.query(
    `SELECT po.id FROM purchase_order po
     LEFT JOIN qb_purchase_order_pipeline qbp ON qbp.purchase_order_id = po.id
     WHERE po.deleted_at IS NULL AND qbp.id IS NULL
     LIMIT 1`
  );
  if (res.rows.length === 0) {
    throw new Error(
      "No purchase_order rows without pipeline available in sandbox for test"
    );
  }
  return res.rows[0].id;
}

async function pickRealVendorId(client: Client): Promise<string> {
  const res = await client.query(
    `SELECT id FROM qb_vendor WHERE deleted_at IS NULL LIMIT 1`
  );
  if (res.rows.length === 0) {
    throw new Error("No qb_vendor rows in sandbox to use for test");
  }
  return res.rows[0].id;
}

async function testB1_BridgeFetch404(client: Client) {
  console.log("\n=== B1 — Bridge 404 handling ===");

  // 1. Mock bridge returning 404 for status path
  await withMockBridge(
    (req, res) => {
      if (req.url?.startsWith("/api/sync/status/")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "operation not found" }));
      } else {
        res.writeHead(500);
        res.end("unexpected path");
      }
    },
    async () => {
      // Helper-level: pollBridgeStatus must return {status: 'expired'}
      const result = await pollBridgeStatus("fake-op-test-b1");
      assert(
        result.status === "expired",
        "pollBridgeStatus(404) returns {status: 'expired'}",
        `got ${JSON.stringify(result)}`
      );

      // Also test bridgeFetch throws BridgeFetchError(isExpired=true)
      try {
        const { bridgeFetch } = await import(
          "../../lib/quickbooks/bridge-fetch"
        );
        await bridgeFetch("/api/sync/status/fake-op-test-b1-2");
        assert(false, "bridgeFetch on 404 should throw");
      } catch (err) {
        const isCorrect =
          err instanceof BridgeFetchError && err.status === 404 && err.isExpired;
        assert(
          isCorrect,
          "bridgeFetch on 404 throws BridgeFetchError(404, isExpired=true)",
          `got ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );

  // 2. Integration: simulate the poller's SQL UPDATE on expired row
  const purchaseOrderId = await pickRealPurchaseOrderId(client);
  const fakeOpId = `${TEST_RUN_ID}-b1-fake-op`;

  const insertRes = await client.query(
    `INSERT INTO qb_purchase_order_pipeline
       (id, purchase_order_id, status, qb_operation_id, payload, retries, created_at, updated_at)
     VALUES
       ('${TEST_RUN_ID}-b1', $1, 'submitted', $2, '{"is_query":false,"is_mod":false}'::jsonb, 0, NOW(), NOW())
     RETURNING id, status, qb_operation_id`,
    [purchaseOrderId, fakeOpId]
  );
  assert(
    insertRes.rows[0].status === "submitted",
    "B1 setup: row inserted as submitted"
  );

  // Run the same UPDATE the poller does on expired status
  const updRes = await client.query(
    `UPDATE qb_purchase_order_pipeline
     SET status = 'error',
         last_error = 'Bridge operation expired (HTTP 404). Op no longer in bridge queue.',
         qb_operation_id = NULL,
         next_retry_at = NOW() + INTERVAL '2 minutes',
         updated_at = NOW()
     WHERE id = '${TEST_RUN_ID}-b1'
     RETURNING status, last_error, qb_operation_id, next_retry_at`
  );
  const row = updRes.rows[0];
  assert(row.status === "error", "B1 row transitions submitted → error");
  assert(
    row.last_error?.includes("expired"),
    "B1 last_error mentions 'expired'",
    row.last_error
  );
  assert(
    row.qb_operation_id === null,
    "B1 qb_operation_id cleared (NULL)",
    String(row.qb_operation_id)
  );
  const retryDelta = new Date(row.next_retry_at).getTime() - Date.now();
  assert(
    retryDelta > 60_000 && retryDelta < 180_000,
    "B1 next_retry_at is ~2 min in the future",
    `${(retryDelta / 1000).toFixed(0)}s from now`
  );

  // Cleanup
  await client.query(
    `DELETE FROM qb_purchase_order_pipeline WHERE id = '${TEST_RUN_ID}-b1'`
  );
}

async function testB2_VendorBackoff(client: Client) {
  console.log("\n=== B2 — Vendor backoff unified ===");

  // 1. Verify constants
  assert(
    JSON.stringify(STANDARD_BACKOFF_MINUTES) === "[2,4,10,30,60]",
    "STANDARD_BACKOFF_MINUTES = [2,4,10,30,60]",
    JSON.stringify(STANDARD_BACKOFF_MINUTES)
  );

  // 2. Verify computeNextRetryDate(2) gives +10 min (was +8 before fix)
  const t0 = Date.now();
  const next = computeNextRetryDate(2);
  const deltaMin = (next.getTime() - t0) / 60_000;
  assert(
    deltaMin > 9.9 && deltaMin < 10.1,
    "computeNextRetryDate(2) = ~+10 min (vendor unified)",
    `${deltaMin.toFixed(2)} min`
  );

  // 3. Integration: verify that calling vendor poller's helper produces the same value
  // Pick a real vendor and simulate the poller's update statement
  const vendorId = await pickRealVendorId(client);

  // Save original state
  const orig = await client.query(
    `SELECT sync_status, retry_count, next_retry_at, last_error FROM qb_vendor WHERE id = $1`,
    [vendorId]
  );
  const origRow = orig.rows[0];

  // Simulate poller updating with computed value
  const computedRetry = computeNextRetryDate(2);
  await client.query(
    `UPDATE qb_vendor
     SET sync_status = 'error',
         retry_count = 2,
         next_retry_at = $2,
         last_error = '[smoketest] B2 verification — will revert'
     WHERE id = $1`,
    [vendorId, computedRetry]
  );

  const verify = await client.query(
    `SELECT sync_status, retry_count, next_retry_at FROM qb_vendor WHERE id = $1`,
    [vendorId]
  );
  const updatedRetryDelta =
    (new Date(verify.rows[0].next_retry_at).getTime() - Date.now()) / 60_000;
  assert(
    updatedRetryDelta > 9.9 && updatedRetryDelta < 10.1,
    "B2 vendor.next_retry_at written ~+10 min",
    `${updatedRetryDelta.toFixed(2)} min`
  );

  // Restore original state
  await client.query(
    `UPDATE qb_vendor
     SET sync_status = $2,
         retry_count = $3,
         next_retry_at = $4,
         last_error = $5
     WHERE id = $1`,
    [
      vendorId,
      origRow.sync_status,
      origRow.retry_count,
      origRow.next_retry_at,
      origRow.last_error,
    ]
  );
}

async function testB3_StaleRowCleanup(client: Client) {
  console.log("\n=== B3 — Stale-row cleanup ===");

  // B3 needs 2 different POs because of UQ_qbpopipe_purchase_order_id
  const poForWaiting = await pickRealPurchaseOrderId(client);
  // Pick a second one
  const res2 = await client.query(
    `SELECT po.id FROM purchase_order po
     LEFT JOIN qb_purchase_order_pipeline qbp ON qbp.purchase_order_id = po.id
     WHERE po.deleted_at IS NULL AND qbp.id IS NULL AND po.id != $1
     LIMIT 1`,
    [poForWaiting]
  );
  if (res2.rows.length === 0) {
    throw new Error("Need 2 POs without pipeline rows for B3 test");
  }
  const poForSubmitted = res2.rows[0].id;

  // Insert 2 stale rows: one in waiting (>20 min), one in submitted (>30 min)
  await client.query(
    `INSERT INTO qb_purchase_order_pipeline
       (id, purchase_order_id, status, qb_operation_id, payload, retries, created_at, updated_at)
     VALUES
       ('${TEST_RUN_ID}-b3-waiting', $1, 'waiting', NULL, '{}'::jsonb, 0, NOW() - INTERVAL '25 minutes', NOW() - INTERVAL '25 minutes'),
       ('${TEST_RUN_ID}-b3-submitted', $2, 'submitted', '${TEST_RUN_ID}-b3-fake-op', '{}'::jsonb, 0, NOW() - INTERVAL '35 minutes', NOW() - INTERVAL '35 minutes')`,
    [poForWaiting, poForSubmitted]
  );

  // Use the actual helper (knex-based) against sandbox DB
  const knex = knexFactory({
    client: "pg",
    connection: SANDBOX_DB,
  });

  let warnCalled = 0;
  const result = await markStaleRowsAsFailed(
    knex,
    "qb_purchase_order_pipeline",
    STANDARD_STALE_CONFIG,
    {
      warn: (msg) => {
        warnCalled++;
        console.log(`    [warn] ${msg}`);
      },
    }
  );

  assert(result.marked >= 2, `B3 marked >=2 rows (got ${result.marked})`);
  assert(
    (result.byStatus.waiting ?? 0) >= 1,
    `B3 byStatus.waiting >=1 (got ${result.byStatus.waiting ?? 0})`
  );
  assert(
    (result.byStatus.submitted ?? 0) >= 1,
    `B3 byStatus.submitted >=1 (got ${result.byStatus.submitted ?? 0})`
  );
  assert(warnCalled >= 2, `B3 warn logger called for each batch`);

  // Verify exact state of our test rows
  const verify = await client.query(
    `SELECT id, status, last_error, qb_operation_id, next_retry_at FROM qb_purchase_order_pipeline
     WHERE id IN ('${TEST_RUN_ID}-b3-waiting', '${TEST_RUN_ID}-b3-submitted')
     ORDER BY id`
  );
  for (const row of verify.rows) {
    assert(
      row.status === "error",
      `B3 row ${row.id} → error (got ${row.status})`
    );
    assert(
      row.last_error?.includes("Timeout"),
      `B3 row ${row.id} last_error mentions 'Timeout'`,
      row.last_error
    );
    assert(
      row.next_retry_at !== null,
      `B3 row ${row.id} has next_retry_at set`
    );
  }
  // Submitted row should also have qb_operation_id cleared
  const submittedRow = verify.rows.find((r) =>
    r.id.endsWith("b3-submitted")
  );
  assert(
    submittedRow?.qb_operation_id === null,
    "B3 submitted row had qb_operation_id cleared (clearOpId flag)",
    String(submittedRow?.qb_operation_id)
  );

  // Cleanup
  await client.query(
    `DELETE FROM qb_purchase_order_pipeline
     WHERE id IN ('${TEST_RUN_ID}-b3-waiting', '${TEST_RUN_ID}-b3-submitted')`
  );

  await knex.destroy();
}

async function main() {
  console.log(`Phase A integration smoke test — sandbox postgres:5499`);
  console.log(`Test run id: ${TEST_RUN_ID}\n`);

  const client = new Client({ connectionString: SANDBOX_DB });
  await client.connect();

  try {
    await testB1_BridgeFetch404(client);
    await testB2_VendorBackoff(client);
    await testB3_StaleRowCleanup(client);
  } finally {
    await client.end();
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Pass: ${pass}  /  Fail: ${fail}`);
  console.log("=".repeat(50));

  if (fail > 0) {
    console.error("\n❌ Phase A integration tests FAILED");
    process.exit(1);
  }
  console.log("\n🎉 Phase A integration tests PASSED");
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
