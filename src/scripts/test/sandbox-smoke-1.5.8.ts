/**
 * Section 1.5.8 Integration Smoke Test — sandbox postgres:5499
 *
 * Validates Credit Memos pipeline-only:
 *   - 5 callers (4 routes + 1 retry) no longer call createCreditMemoInQb /
 *     updateCreditMemoInQb / voidCreditMemoInQb directly
 *   - consolidator pending-dispatch includes 'credit_memo' + 'void_credit_memo'
 *   - consolidator has cases for credit_memo (CREATE) and void_credit_memo
 *   - SQL contract: pending CM rows pickable
 */

process.env.DATABASE_URL =
  "postgresql://postgres:sandbox@localhost:5499/medusa";

import { Client } from "pg";
import { randomUUID } from "crypto";
import * as fs from "fs";

const SANDBOX_DB = process.env.DATABASE_URL!;
const TEST_RUN_ID = `t158-${Date.now()}`;
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
  consolidator:
    "/home/alejo/webapps/ecopowertech-workspace/backend/src/jobs/qb-pipeline-consolidator.ts",
  cmComplete:
    "/home/alejo/webapps/ecopowertech-workspace/backend/src/api/admin/pos/credit_memos/[id]/complete/route.ts",
  cmVoid:
    "/home/alejo/webapps/ecopowertech-workspace/backend/src/api/admin/pos/credit_memos/[id]/void/route.ts",
  cmPatchMeta:
    "/home/alejo/webapps/ecopowertech-workspace/backend/src/api/admin/pos/credit_memos/[id]/patch-meta/route.ts",
  posSync:
    "/home/alejo/webapps/ecopowertech-workspace/backend/src/api/admin/pos/sync/route.ts",
  pipelineRetry:
    "/home/alejo/webapps/ecopowertech-workspace/backend/src/api/admin/quickbooks/pipeline/route.ts",
};

function readFile(label: keyof typeof PATHS): string {
  return fs.readFileSync(PATHS[label], "utf-8");
}

function testStaticChecks() {
  console.log("\n=== TEST 1 — credit_memos/complete enqueues credit_memo ===");
  const c = readFile("cmComplete");
  assert(
    !/await\s+createCreditMemoInQb\(/.test(c),
    "complete does NOT call createCreditMemoInQb"
  );
  assert(
    /step:\s*"credit_memo"/.test(c) && /status:\s*"pending"/.test(c),
    "complete enqueues 'credit_memo' as 'pending'"
  );

  console.log("\n=== TEST 2 — credit_memos/void enqueues void_credit_memo ===");
  const v = readFile("cmVoid");
  assert(
    !/await\s+voidCreditMemoInQb\(/.test(v),
    "void route does NOT call voidCreditMemoInQb"
  );
  assert(
    /step:\s*"void_credit_memo"/.test(v) && /status:\s*"pending"/.test(v),
    "void route enqueues 'void_credit_memo' as 'pending'"
  );

  console.log("\n=== TEST 3 — credit_memos/patch-meta enqueues credit_memo_mod ===");
  const pm = readFile("cmPatchMeta");
  assert(
    !/updateCreditMemoInQb\(/.test(pm),
    "patch-meta does NOT call updateCreditMemoInQb"
  );
  assert(
    /step:\s*"credit_memo_mod"/.test(pm) && /status:\s*"pending"/.test(pm),
    "patch-meta enqueues 'credit_memo_mod' as 'pending'"
  );

  console.log("\n=== TEST 4 — pos/sync CM create + void enqueues ===");
  const ps = readFile("posSync");
  assert(
    !/await\s+createCreditMemoInQb\(/.test(ps),
    "pos/sync does NOT call createCreditMemoInQb"
  );
  assert(
    !/await\s+voidCreditMemoInQb\(/.test(ps),
    "pos/sync does NOT call voidCreditMemoInQb"
  );
  assert(
    /enqueueCmCreate/.test(ps),
    "pos/sync uses enqueueCmCreate for credit_memo create branch"
  );

  console.log("\n=== TEST 5 — quickbooks/pipeline retry CM enqueues ===");
  const pr = readFile("pipelineRetry");
  // The retry block for credit_memo no longer calls createCreditMemoInQb directly
  const cmRetryStart = pr.indexOf('case "credit_memo":');
  const cmRetryEnd = pr.indexOf("default:", cmRetryStart);
  const cmRetryBlock = cmRetryStart >= 0 ? pr.substring(cmRetryStart, cmRetryEnd) : "";
  assert(cmRetryBlock.length > 0, "found credit_memo case in retry");
  assert(
    !/await\s+createCreditMemoInQb\(/.test(cmRetryBlock),
    "retry CM case does NOT call createCreditMemoInQb"
  );
  assert(
    /SET status = 'pending'/.test(cmRetryBlock),
    "retry CM case resets row to 'pending'"
  );

  console.log("\n=== TEST 6 — Consolidator extensions ===");
  const cons = readFile("consolidator");
  assert(
    /step IN \([^)]*'credit_memo'[^)]*\)/.test(cons),
    "pending-dispatch SQL includes 'credit_memo'"
  );
  assert(
    /step IN \([^)]*'void_credit_memo'[^)]*\)/.test(cons),
    "pending-dispatch SQL includes 'void_credit_memo'"
  );
  // Find the case body by case label and the NEXT case/default (handles
  // nested break statements correctly).
  function caseBody(label: string): string {
    const start = cons.indexOf(`case "${label}":`);
    if (start < 0) return "";
    // Find next "case " or "default:" after start
    const nextCase = cons.indexOf("case \"", start + 1);
    const nextDefault = cons.indexOf("default:", start + 1);
    let end = cons.length;
    if (nextCase > 0) end = Math.min(end, nextCase);
    if (nextDefault > 0) end = Math.min(end, nextDefault);
    return cons.substring(start, end);
  }
  const cmCreateBody = caseBody("credit_memo");
  assert(
    cmCreateBody.includes("case \"credit_memo\":"),
    "consolidator has case 'credit_memo' (CREATE)"
  );
  assert(
    /createCreditMemoInQb\(/.test(cmCreateBody),
    "case 'credit_memo' calls createCreditMemoInQb"
  );
  const voidCmBody = caseBody("void_credit_memo");
  assert(
    voidCmBody.includes("case \"void_credit_memo\":"),
    "consolidator has case 'void_credit_memo'"
  );
  assert(
    /voidCreditMemoInQb\(/.test(voidCmBody),
    "case 'void_credit_memo' calls voidCreditMemoInQb"
  );
}

async function testEnqueueAndPickup(client: Client) {
  console.log("\n=== TEST 7 — pending credit_memo + void_credit_memo rows pickable ===");

  const cmRow = await client.query(
    `SELECT id FROM pos_credit_memo WHERE qb_txn_id IS NOT NULL LIMIT 1`
  );
  const cmId = cmRow.rows[0]?.id;
  if (!cmId) throw new Error("No completed credit_memo in sandbox");

  // Insert one credit_memo and one void_credit_memo
  for (const step of ["credit_memo", "void_credit_memo"]) {
    const rowId = randomUUID();
    const payload =
      step === "credit_memo"
        ? { customerId: "cust-fake", items: [], memo: "test" }
        : { editSequence: "12345" };
    await client.query(
      `INSERT INTO qb_order_pipeline (id, reference_id, reference_type, step, status, qb_txn_id, payload, created_at, updated_at)
       VALUES ($1, $2, 'credit_memo', $3, 'pending', $4, $5::jsonb, NOW(), NOW())`,
      [
        rowId,
        cmId,
        step,
        step === "void_credit_memo" ? `${TEST_RUN_ID}-fake-txn` : null,
        JSON.stringify(payload),
      ]
    );
    TEST_ROW_IDS.push(rowId);
  }

  const dispatch = await client.query(`
    SELECT id, step FROM qb_order_pipeline
     WHERE step IN ('estimate_cancel', 'credit_memo_mod', 'transfer_customer', 'estimate', 'sales_order', 'so_close', 'so_reopen', 'sales_receipt', 'invoice', 'credit_memo', 'void_credit_memo')
       AND status = 'pending'
       AND id = ANY($1::uuid[])
  `, [TEST_ROW_IDS]);
  assert(
    dispatch.rows.length === 2,
    `pending-dispatch picks up both rows (got ${dispatch.rows.length})`
  );
  const steps = dispatch.rows.map((r) => r.step).sort();
  assert(
    JSON.stringify(steps) === JSON.stringify(["credit_memo", "void_credit_memo"]),
    "picked correct 2 step types"
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
  console.log("Section 1.5.8 integration smoke test");
  console.log(`Test run id: ${TEST_RUN_ID}\n`);

  testStaticChecks();

  const client = new Client({ connectionString: SANDBOX_DB });
  await client.connect();

  try {
    await testEnqueueAndPickup(client);
  } finally {
    await cleanup(client);
    await client.end();
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Pass: ${pass}  /  Fail: ${fail}`);
  console.log("=".repeat(50));

  if (fail > 0) {
    console.error("\n❌ 1.5.8 integration tests FAILED");
    process.exit(1);
  }
  console.log("\n🎉 1.5.8 integration tests PASSED");
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
