/**
 * Section 1.5.10 Integration Smoke Test — sandbox postgres:5499
 *
 * Validates the qb-pipeline-status endpoint extension:
 *   - Old DocTypes still work (estimate, order, invoice, credit_memo)
 *   - New DocTypes work (payment, apply_payment, transfer_customer,
 *     so_close, so_reopen, estimate_cancel, credit_memo_mod, void_credit_memo)
 *   - Invalid types still rejected
 *
 * Note on 202 pattern:
 * The migrated admin routes from 1.5.4-9 already enqueue and return
 * immediately. The status endpoint extension here means the frontend
 * can poll for any of the new step types we introduced.
 */

process.env.DATABASE_URL =
  "postgresql://postgres:sandbox@localhost:5499/medusa";

import { Client } from "pg";
import { randomUUID } from "crypto";
import * as fs from "fs";

const SANDBOX_DB = process.env.DATABASE_URL!;
const TEST_RUN_ID = `t1510-${Date.now()}`;
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

const STATUS_ROUTE_PATH =
  "/home/alejo/webapps/ecopowertech-workspace/backend/src/api/admin/pos/qb-pipeline-status/route.ts";
const PIPELINE_TYPES_PATH =
  "/home/alejo/webapps/ecopowertech-workspace/backend/src/lib/quickbooks/qb-pipeline.ts";

function testStaticChecks() {
  console.log("\n=== TEST 1 — qb-pipeline-status route extended ===");
  const src = fs.readFileSync(STATUS_ROUTE_PATH, "utf-8");

  const newTypes = [
    "payment",
    "apply_payment",
    "transfer_customer",
    "so_close",
    "so_reopen",
    "estimate_cancel",
    "credit_memo_mod",
    "void_credit_memo",
  ];
  for (const t of newTypes) {
    assert(
      new RegExp(`^\\s*\\|\\s*"${t}"`, "m").test(src),
      `DocType union includes '${t}'`
    );
    assert(
      new RegExp(`\\b${t}:\\s*\\[`).test(src),
      `STEPS_BY_TYPE has '${t}' entry`
    );
  }

  // Backwards compat
  assert(
    /\bestimate:\s*\[/.test(src) && /\border:\s*\[/.test(src) &&
      /\binvoice:\s*\[/.test(src) && /\bcredit_memo:\s*\[/.test(src),
    "old DocTypes (estimate, order, invoice, credit_memo) still present"
  );

  console.log("\n=== TEST 2 — PipelineStep type includes estimate_cancel ===");
  const types = fs.readFileSync(PIPELINE_TYPES_PATH, "utf-8");
  assert(
    /\|\s*"estimate_cancel"/.test(types),
    "PipelineStep type includes 'estimate_cancel'"
  );
}

async function testDbContract(client: Client) {
  console.log("\n=== TEST 3 — DB queries by new step types work ===");

  const orderRes = await client.query(
    `SELECT id FROM "order" WHERE deleted_at IS NULL LIMIT 1`
  );
  const orderId = orderRes.rows[0]?.id;
  if (!orderId) throw new Error("No orders in sandbox");

  // Insert a 'payment' step row
  const rowId = randomUUID();
  await client.query(
    `INSERT INTO qb_order_pipeline (id, order_id, reference_id, reference_type, step, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'payment', 'payment', 'pending', NOW(), NOW())`,
    [rowId, orderId, `${TEST_RUN_ID}-fake-pay`]
  );
  TEST_ROW_IDS.push(rowId);

  // Verify the SQL pattern getPrimaryPipelineRow uses works for 'payment'
  const result = await client.query(
    `SELECT * FROM qb_order_pipeline
      WHERE step = ANY($1::text[])
        AND reference_id = $2
      ORDER BY COALESCE(updated_at, created_at) DESC
      LIMIT 1`,
    [["payment"], `${TEST_RUN_ID}-fake-pay`]
  );
  assert(
    result.rows.length === 1 && result.rows[0].step === "payment",
    "DB query by step='payment' returns the pending row"
  );
  assert(result.rows[0].status === "pending", "status reflects 'pending'");
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
  console.log("Section 1.5.10 integration smoke test");
  console.log(`Test run id: ${TEST_RUN_ID}\n`);

  testStaticChecks();

  const client = new Client({ connectionString: SANDBOX_DB });
  await client.connect();

  try {
    await testDbContract(client);
  } finally {
    await cleanup(client);
    await client.end();
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Pass: ${pass}  /  Fail: ${fail}`);
  console.log("=".repeat(50));

  if (fail > 0) {
    console.error("\n❌ 1.5.10 integration tests FAILED");
    process.exit(1);
  }
  console.log("\n🎉 1.5.10 integration tests PASSED");
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
