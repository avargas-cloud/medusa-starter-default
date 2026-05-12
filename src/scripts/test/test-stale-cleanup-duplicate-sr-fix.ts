/**
 * Test: stale-cleanup-pass + handleSalesReceiptCreated secondary guard
 *
 * Simulates the S10345 duplicate SR scenario — a submitted pipeline row whose
 * bridge op is still pending gets stale-marked and retried, producing two SRs.
 *
 * Verifies:
 *   Test 1 — Stale cleanup skips (extends window) when bridge says "pending"
 *   Test 2 — Stale cleanup marks failed when bridge says op not found / no bridge_op_id
 *   Test 3 — Stale cleanup marks failed when bridge op pending for >2h (hard abandon)
 *   Test 4 — Secondary guard in handleSalesReceiptCreated restores row to 'submitted'
 *             and returns early when bridge op still pending
 *
 * Run against sandbox:
 *   DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *   QB_BRIDGE_URL=http://localhost:9987 \
 *   npx ts-node src/scripts/test/test-stale-cleanup-duplicate-sr-fix.ts
 */

import http from "http";
import { Client } from "pg";

const DB_URL =
  process.env.DATABASE_URL ||
  "postgresql://postgres:sandbox@localhost:5499/medusa";
const MOCK_BRIDGE_PORT = 9987;

// ─── Mock bridge server ───────────────────────────────────────────────────────

type BridgeScenario = "pending" | "completed" | "not_found";
let currentScenario: BridgeScenario = "pending";
let bridgeCallCount = 0;

function startMockBridge(): http.Server {
  const server = http.createServer((req, res) => {
    bridgeCallCount++;
    if (req.url?.startsWith("/api/sync/status/") && req.method === "GET") {
      const opId = req.url.replace("/api/sync/status/", "");
      if (opId === "non-existent-op" || currentScenario === "not_found") {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          operation: { id: opId, status: currentScenario },
        })
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(MOCK_BRIDGE_PORT, "127.0.0.1");
  return server;
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

async function insertFakePipelineRow(
  client: Client,
  opts: {
    id: string;
    orderId: string;
    step: string;
    status: string;
    bridgeOpId: string | null;
    submittedAgoMinutes: number;
    updatedAgoMinutes: number;
    failedAgoMinutes?: number;
  }
): Promise<void> {
  const failedAt =
    opts.failedAgoMinutes !== undefined
      ? `NOW() - INTERVAL '${opts.failedAgoMinutes} minutes'`
      : "NULL";

  await client.query(
    `INSERT INTO qb_order_pipeline
       (id, order_id, step, status, bridge_op_id, submitted_at, updated_at, failed_at, created_at)
     VALUES
       ($1, $2, $3, $4, $5,
        NOW() - ($6 || ' minutes')::interval,
        NOW() - ($7 || ' minutes')::interval,
        ${failedAt},
        NOW() - ($6 || ' minutes')::interval)
     ON CONFLICT (id) DO NOTHING`,
    [
      opts.id,
      opts.orderId,
      opts.step,
      opts.status,
      opts.bridgeOpId,
      opts.submittedAgoMinutes.toString(),
      opts.updatedAgoMinutes.toString(),
    ]
  );
}

async function getRowStatus(
  client: Client,
  id: string
): Promise<{ status: string; updated_at: Date; failed_at: Date | null; bridge_op_id: string | null } | null> {
  const { rows } = await client.query(
    `SELECT status, updated_at, failed_at, bridge_op_id FROM qb_order_pipeline WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

async function cleanup(client: Client, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await client.query(
    `DELETE FROM qb_order_pipeline WHERE id = ANY($1::uuid[])`,
    [ids]
  );
}

// ─── Inline stale cleanup (mirrors fixed runStaleSubmittedCleanup logic) ─────

async function runStaleCleanupInline(
  client: Client,
  log: (msg: string) => void
): Promise<void> {
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

  const { rows: staleSubmitted } = await client.query(
    `SELECT id, step, qb_txn_id, bridge_op_id, submitted_at
     FROM qb_order_pipeline
     WHERE status = 'submitted' AND updated_at < NOW() - INTERVAL '30 minutes'
       AND order_id LIKE 'order_test_%'`
  );

  for (const row of staleSubmitted) {
    if (row.bridge_op_id) {
      let shouldFail = false;
      try {
        const resp = await fetch(
          `http://127.0.0.1:${MOCK_BRIDGE_PORT}/api/sync/status/${row.bridge_op_id}`
        );
        if (!resp.ok) {
          shouldFail = true;
        } else {
          const data = (await resp.json()) as { operation?: { status?: string } };
          const opStatus = data?.operation?.status;
          if (opStatus === "pending" || opStatus === "processing") {
            const submittedMs = row.submitted_at
              ? Date.now() - new Date(row.submitted_at).getTime()
              : Infinity;
            if (submittedMs < TWO_HOURS_MS) {
              await client.query(
                `UPDATE qb_order_pipeline SET updated_at = NOW() WHERE id = $1`,
                [row.id]
              );
              log(`  EXTEND: row ${row.id} (step=${row.step}) bridge still ${opStatus}`);
              continue;
            }
            log(`  ABANDON >2h: row ${row.id} bridge pending too long`);
            shouldFail = true;
          } else if (opStatus === "completed") {
            await client.query(
              `UPDATE qb_order_pipeline SET updated_at = NOW() WHERE id = $1`,
              [row.id]
            );
            log(`  COMPLETED: row ${row.id} bridge already done, bumping for poll`);
            continue;
          } else {
            shouldFail = true;
          }
        }
      } catch {
        log(`  BRIDGE UNREACHABLE: leaving row ${row.id} as submitted`);
        continue;
      }
      if (!shouldFail) continue;
    }

    await client.query(
      `UPDATE qb_order_pipeline
       SET status='failed', error='Stale test', updated_at=NOW(), failed_at=NOW(), confirmed_at=NULL
       WHERE id=$1`,
      [row.id]
    );
    log(`  FAILED: row ${row.id} marked failed`);
  }
}

// ─── Secondary guard check (mirrors handleSalesReceiptCreated guard) ──────────

async function runSecondaryGuardInline(
  client: Client,
  orderId: string,
  log: (msg: string) => void
): Promise<"skipped" | "proceeded"> {
  const { rows: failedWithOp } = await client.query(
    `SELECT id, bridge_op_id FROM qb_order_pipeline
     WHERE order_id = $1 AND step = 'sales_receipt'
       AND status = 'failed' AND bridge_op_id IS NOT NULL
       AND failed_at > NOW() - INTERVAL '2 hours'
     ORDER BY failed_at DESC LIMIT 1`,
    [orderId]
  );

  if (failedWithOp.length > 0) {
    const { id: failedRowId, bridge_op_id: oldOpId } = failedWithOp[0] as {
      id: string;
      bridge_op_id: string;
    };
    try {
      const resp = await fetch(
        `http://127.0.0.1:${MOCK_BRIDGE_PORT}/api/sync/status/${oldOpId}`
      );
      if (resp.ok) {
        const data = (await resp.json()) as { operation?: { status?: string } };
        const opStatus = data?.operation?.status;
        if (opStatus === "pending" || opStatus === "processing") {
          await client.query(
            `UPDATE qb_order_pipeline
             SET status='submitted', failed_at=NULL, error=NULL, updated_at=NOW()
             WHERE id=$1`,
            [failedRowId]
          );
          log(
            `  GUARD: bridge op ${oldOpId} still ${opStatus} — row ${failedRowId} restored to submitted, skipping SR creation`
          );
          return "skipped";
        }
      }
    } catch {
      log(`  GUARD: bridge unreachable, proceeding with SR creation`);
    }
  }
  log(`  GUARD: no blocking condition — would proceed with SR creation`);
  return "proceeded";
}

// ─── Test runner ──────────────────────────────────────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  details: string[];
}

async function main(): Promise<void> {
  const server = startMockBridge();
  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  const results: TestResult[] = [];
  const allTestIds: string[] = [];

  // ── Test 1: stale cleanup — bridge says "pending" → extend window ─────────
  {
    const ROW_ID = "a0000001-0000-0000-0000-000000000001";
    allTestIds.push(ROW_ID);
    currentScenario = "pending";
    bridgeCallCount = 0;

    const log: string[] = [];
    await cleanup(client, [ROW_ID]);
    await insertFakePipelineRow(client, {
      id: ROW_ID,
      orderId: "order_test_001",
      step: "sales_receipt",
      status: "submitted",
      bridgeOpId: "bridge-op-pending-001",
      submittedAgoMinutes: 35,
      updatedAgoMinutes: 35,
    });

    await runStaleCleanupInline(client, (m) => log.push(m));

    const row = await getRowStatus(client, ROW_ID);
    const extended =
      row?.status === "submitted" &&
      row?.failed_at === null &&
      row?.updated_at &&
      Date.now() - row.updated_at.getTime() < 5000; // updated < 5s ago

    results.push({
      name: "Test 1: stale cleanup bridge=pending → extend window (NOT fail)",
      passed: !!extended,
      details: [
        `  row.status = ${row?.status} (want: submitted)`,
        `  row.failed_at = ${row?.failed_at ?? "null"} (want: null)`,
        `  updated_at fresh = ${extended}`,
        `  bridge calls = ${bridgeCallCount} (want: 1)`,
        ...log,
      ],
    });
  }

  // ── Test 2: stale cleanup — no bridge_op_id → mark failed as usual ────────
  {
    const ROW_ID = "a0000002-0000-0000-0000-000000000002";
    allTestIds.push(ROW_ID);
    bridgeCallCount = 0;
    const log: string[] = [];

    await cleanup(client, [ROW_ID]);
    await insertFakePipelineRow(client, {
      id: ROW_ID,
      orderId: "order_test_002",
      step: "sales_receipt",
      status: "submitted",
      bridgeOpId: null,
      submittedAgoMinutes: 35,
      updatedAgoMinutes: 35,
    });

    await runStaleCleanupInline(client, (m) => log.push(m));

    const row = await getRowStatus(client, ROW_ID);
    const failed =
      row?.status === "failed" && row?.failed_at !== null;

    results.push({
      name: "Test 2: stale cleanup no bridge_op_id → mark failed (normal path)",
      passed: !!failed,
      details: [
        `  row.status = ${row?.status} (want: failed)`,
        `  row.failed_at = ${row?.failed_at} (want: non-null)`,
        `  bridge calls = ${bridgeCallCount} (want: 0)`,
        ...log,
      ],
    });
  }

  // ── Test 3: stale cleanup — bridge=pending but >2h → force fail ──────────
  {
    const ROW_ID = "a0000003-0000-0000-0000-000000000003";
    allTestIds.push(ROW_ID);
    currentScenario = "pending";
    bridgeCallCount = 0;
    const log: string[] = [];

    await cleanup(client, [ROW_ID]);
    await insertFakePipelineRow(client, {
      id: ROW_ID,
      orderId: "order_test_003",
      step: "sales_receipt",
      status: "submitted",
      bridgeOpId: "bridge-op-old-stuck-001",
      submittedAgoMinutes: 130, // >2h
      updatedAgoMinutes: 35,
    });

    await runStaleCleanupInline(client, (m) => log.push(m));

    const row = await getRowStatus(client, ROW_ID);
    const failed = row?.status === "failed" && row?.failed_at !== null;

    results.push({
      name: "Test 3: stale cleanup bridge=pending but >2h → force fail (abandon)",
      passed: !!failed,
      details: [
        `  row.status = ${row?.status} (want: failed)`,
        `  row.failed_at = ${row?.failed_at} (want: non-null)`,
        ...log,
      ],
    });
  }

  // ── Test 4: stale cleanup — bridge=completed → bump updated_at for poll ───
  {
    const ROW_ID = "a0000004-0000-0000-0000-000000000004";
    allTestIds.push(ROW_ID);
    currentScenario = "completed";
    bridgeCallCount = 0;
    const log: string[] = [];

    await cleanup(client, [ROW_ID]);
    await insertFakePipelineRow(client, {
      id: ROW_ID,
      orderId: "order_test_004",
      step: "sales_receipt",
      status: "submitted",
      bridgeOpId: "bridge-op-completed-001",
      submittedAgoMinutes: 35,
      updatedAgoMinutes: 35,
    });

    await runStaleCleanupInline(client, (m) => log.push(m));

    const row = await getRowStatus(client, ROW_ID);
    const bumped =
      row?.status === "submitted" &&
      row?.failed_at === null &&
      row?.updated_at &&
      Date.now() - row.updated_at.getTime() < 5000;

    results.push({
      name: "Test 4: stale cleanup bridge=completed → bump updated_at (stays submitted for poll)",
      passed: !!bumped,
      details: [
        `  row.status = ${row?.status} (want: submitted)`,
        `  row.failed_at = ${row?.failed_at ?? "null"} (want: null)`,
        `  updated_at fresh = ${bumped}`,
        ...log,
      ],
    });
  }

  // ── Test 5: secondary guard — failed row + bridge pending → skip SR ────────
  {
    const ROW_ID = "a0000005-0000-0000-0000-000000000005";
    allTestIds.push(ROW_ID);
    currentScenario = "pending";
    bridgeCallCount = 0;
    const log: string[] = [];

    await cleanup(client, [ROW_ID]);
    await insertFakePipelineRow(client, {
      id: ROW_ID,
      orderId: "order_test_005",
      step: "sales_receipt",
      status: "failed",
      bridgeOpId: "bridge-op-guard-test-001",
      submittedAgoMinutes: 35,
      updatedAgoMinutes: 35,
      failedAgoMinutes: 10,
    });

    const outcome = await runSecondaryGuardInline(client, "order_test_005", (m) => log.push(m));
    const restoredRow = await getRowStatus(client, ROW_ID);

    const passed =
      outcome === "skipped" &&
      restoredRow?.status === "submitted" &&
      restoredRow?.failed_at === null;

    results.push({
      name: "Test 5: secondary guard — failed row + bridge pending → restore to submitted, skip SR creation",
      passed,
      details: [
        `  outcome = ${outcome} (want: skipped)`,
        `  row.status = ${restoredRow?.status} (want: submitted)`,
        `  row.failed_at = ${restoredRow?.failed_at ?? "null"} (want: null)`,
        `  bridge calls = ${bridgeCallCount} (want: 1)`,
        ...log,
      ],
    });
  }

  // ── Test 6: secondary guard — no failed rows → proceed normally ──────────
  {
    const log: string[] = [];
    bridgeCallCount = 0;

    const outcome = await runSecondaryGuardInline(client, "order_no_failed_rows_xyz", (m) =>
      log.push(m)
    );

    results.push({
      name: "Test 6: secondary guard — no failed rows → proceed normally",
      passed: outcome === "proceeded",
      details: [
        `  outcome = ${outcome} (want: proceeded)`,
        `  bridge calls = ${bridgeCallCount} (want: 0)`,
        ...log,
      ],
    });
  }

  // ─── Cleanup test rows ────────────────────────────────────────────────────
  await cleanup(client, allTestIds);
  await client.end();
  server.close();

  // ─── Print results ────────────────────────────────────────────────────────
  let allPassed = true;
  console.log("\n══════════════════════════════════════════════════════");
  console.log("  TEST: stale-cleanup-pass + SR secondary guard fix");
  console.log("══════════════════════════════════════════════════════\n");

  for (const r of results) {
    const icon = r.passed ? "✅" : "❌";
    console.log(`${icon} ${r.name}`);
    for (const d of r.details) console.log(d);
    console.log();
    if (!r.passed) allPassed = false;
  }

  console.log("══════════════════════════════════════════════════════");
  if (allPassed) {
    console.log("  RESULT: ALL TESTS PASSED ✅");
  } else {
    const failed = results.filter((r) => !r.passed).length;
    console.log(`  RESULT: ${failed}/${results.length} TESTS FAILED ❌`);
  }
  console.log("══════════════════════════════════════════════════════\n");

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
