/**
 * Section 1.5.4 Integration Smoke Test — sandbox postgres:5499
 *
 * Validates that the estimate flow is now pipeline-only:
 *   - Subscriber, qb-pos-sync, and 5 admin routes do NOT call the
 *     handler directly anymore — they only enqueue 'pending' rows
 *   - Consolidator's pending-dispatch query includes 'estimate'
 *   - SQL contract for pending estimate rows works (insert + JOIN + UPDATE)
 *
 * Tests:
 *   1. Static — subscriber doesn't call handleDraftOrderCreated for events
 *   2. Static — qb-pos-sync flips status instead of calling handler
 *   3. Static — 4 admin routes enqueue instead of calling handler
 *   4. Static — consolidator's pending-dispatch SQL includes 'estimate'
 *   5. Dynamic — pending estimate row is pickable by SQL
 *   6. Dynamic — POS estimate enqueued as 'waiting' is wakeable to 'pending'
 *
 * Run from /backend dir:
 *   node_modules/.bin/tsx src/scripts/test/sandbox-smoke-1.5.4.ts
 */

process.env.DATABASE_URL =
  "postgresql://postgres:sandbox@localhost:5499/medusa";

import { Client } from "pg";
import { randomUUID } from "crypto";
import * as fs from "fs";

const SANDBOX_DB = process.env.DATABASE_URL!;
const TEST_RUN_ID = `t154-${Date.now()}`;
const TEST_ROW_IDS: string[] = [];

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

const PATHS = {
  subscriber:
    "/home/alejo/webapps/ecopowertech-workspace/backend/src/subscribers/qb-draft-order-subscriber.ts",
  posSync:
    "/home/alejo/webapps/ecopowertech-workspace/backend/src/jobs/qb-pos-sync.ts",
  consolidator:
    "/home/alejo/webapps/ecopowertech-workspace/backend/src/jobs/qb-pipeline-consolidator.ts",
  postEditSync:
    "/home/alejo/webapps/ecopowertech-workspace/backend/src/api/admin/orders/[id]/post-edit-sync/route.ts",
  draftSyncPos:
    "/home/alejo/webapps/ecopowertech-workspace/backend/src/api/admin/draft-orders/sync-pos/route.ts",
  posSyncRoute:
    "/home/alejo/webapps/ecopowertech-workspace/backend/src/api/admin/pos/sync/route.ts",
  pipelineRetry:
    "/home/alejo/webapps/ecopowertech-workspace/backend/src/api/admin/quickbooks/pipeline/route.ts",
  testSync:
    "/home/alejo/webapps/ecopowertech-workspace/backend/src/api/test-sync/[id]/route.ts",
};

function readFile(label: keyof typeof PATHS): string {
  return fs.readFileSync(PATHS[label], "utf-8");
}

function testStaticChecks() {
  console.log("\n=== TEST 1 — Subscriber no longer calls handleDraftOrderCreated for events ===");
  const sub = readFile("subscriber");
  // Extract the qbDraftOrderSubscriber function (the event entry point).
  // Note: the file ALSO exports handleDraftOrderCreated as a separate function
  // for use by the consolidator and other internal callers. We check that the
  // EVENT subscriber doesn't call it.
  const subscriberMatch = sub.match(
    /qbDraftOrderSubscriber[\s\S]+?\n\}\s*\n\s*\/\/[\s\S]*?Event Handlers/
  );
  assert(
    subscriberMatch !== null,
    "found qbDraftOrderSubscriber function block"
  );
  if (subscriberMatch) {
    const block = subscriberMatch[0];
    assert(
      !/await\s+handleDraftOrderCreated\(/.test(block),
      "subscriber does NOT call handleDraftOrderCreated()"
    );
    assert(
      /writePipelineRow\(/.test(block),
      "subscriber enqueues via writePipelineRow"
    );
    assert(
      /step:\s*"estimate"/.test(block),
      "subscriber enqueues with step='estimate'"
    );
    assert(
      /isPos\s*\?\s*"waiting"\s*:\s*"pending"/.test(block),
      "subscriber distinguishes POS (waiting) vs non-POS (pending)"
    );
  }

  console.log(
    "\n=== TEST 2 — qb-pos-sync flips status instead of calling handler ==="
  );
  const posSync = readFile("posSync");
  assert(
    !/await\s+handleDraftOrderCreated\(/.test(posSync),
    "qb-pos-sync does NOT call handleDraftOrderCreated"
  );
  assert(
    /SET status = 'pending'.*WHERE order_id = \$1 AND step = 'estimate' AND status = 'waiting'/s.test(
      posSync
    ),
    "qb-pos-sync flips waiting → pending via SQL UPDATE"
  );

  console.log(
    "\n=== TEST 3 — Admin routes enqueue instead of calling handler ==="
  );
  for (const [label, path] of [
    ["postEditSync", PATHS.postEditSync],
    ["draftSyncPos", PATHS.draftSyncPos],
    ["posSyncRoute", PATHS.posSyncRoute],
    ["pipelineRetry", PATHS.pipelineRetry],
    ["testSync", PATHS.testSync],
  ] as const) {
    const src = fs.readFileSync(path, "utf-8");
    assert(
      !/await\s+handleDraftOrderCreated\([^)]*\)/.test(src) &&
        !/await\s+handleDraftOrderUpdated\([^)]*\)/.test(src),
      `${label}: no direct handler calls`
    );
    assert(
      /writePipelineRow|enqueueEst|enqueue\(/.test(src),
      `${label}: uses writePipelineRow/enqueue`
    );
  }

  console.log(
    "\n=== TEST 4 — Consolidator pending-dispatch includes 'estimate' ==="
  );
  const cons = readFile("consolidator");
  assert(
    /step IN \([^)]*'estimate'[^)]*\)/.test(cons),
    "consolidator pending-dispatch SQL includes 'estimate'"
  );
}

async function testEnqueueAndPickup(client: Client) {
  console.log(
    "\n=== TEST 5 — pending estimate row pickable by consolidator SQL ==="
  );

  const orderRes = await client.query(
    `SELECT id FROM "order" WHERE deleted_at IS NULL LIMIT 1`
  );
  const orderId = orderRes.rows[0]?.id;
  if (!orderId) throw new Error("No orders in sandbox");

  const rowId = randomUUID();
  await client.query(
    `INSERT INTO qb_order_pipeline (id, order_id, step, status, created_at, updated_at)
     VALUES ($1, $2, 'estimate', 'pending', NOW(), NOW())`,
    [rowId, orderId]
  );
  TEST_ROW_IDS.push(rowId);

  const picked = await client.query(`
    SELECT id, step FROM qb_order_pipeline
     WHERE step IN ('estimate_cancel', 'credit_memo_mod', 'transfer_customer', 'estimate')
       AND status = 'pending'
       AND id = $1
  `, [rowId]);
  assert(
    picked.rows.length === 1 && picked.rows[0].step === "estimate",
    "row picked by pending-dispatch SQL"
  );
}

async function testPosWaitingWakeup(client: Client) {
  console.log(
    "\n=== TEST 6 — POS waiting row wakeable to pending via UPDATE ==="
  );

  const orderRes = await client.query(
    `SELECT id FROM "order" WHERE deleted_at IS NULL LIMIT 1 OFFSET 1`
  );
  const orderId = orderRes.rows[0]?.id;
  if (!orderId) throw new Error("No 2nd order in sandbox");

  const rowId = randomUUID();
  await client.query(
    `INSERT INTO qb_order_pipeline (id, order_id, step, status, created_at, updated_at)
     VALUES ($1, $2, 'estimate', 'waiting', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours')`,
    [rowId, orderId]
  );
  TEST_ROW_IDS.push(rowId);

  // Run the same UPDATE qb-pos-sync now uses
  const result = await client.query(
    `UPDATE qb_order_pipeline
        SET status = 'pending', updated_at = NOW()
      WHERE order_id = $1 AND step = 'estimate' AND status = 'waiting'`,
    [orderId]
  );
  assert(
    (result.rowCount ?? 0) >= 1,
    `UPDATE waiting→pending affected at least 1 row (got ${result.rowCount})`
  );

  const final = await client.query(
    `SELECT status FROM qb_order_pipeline WHERE id = $1`,
    [rowId]
  );
  assert(final.rows[0].status === "pending", "row → 'pending'");
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
  console.log("Section 1.5.4 integration smoke test");
  console.log(`Test run id: ${TEST_RUN_ID}\n`);

  testStaticChecks();

  const client = new Client({ connectionString: SANDBOX_DB });
  await client.connect();

  try {
    await testEnqueueAndPickup(client);
    await testPosWaitingWakeup(client);
  } finally {
    await cleanup(client);
    await client.end();
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Pass: ${pass}  /  Fail: ${fail}`);
  console.log("=".repeat(50));

  if (fail > 0) {
    console.error("\n❌ 1.5.4 integration tests FAILED");
    process.exit(1);
  }
  console.log("\n🎉 1.5.4 integration tests PASSED");
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
