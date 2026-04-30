/**
 * Section 1.5.6 Integration Smoke Test — sandbox postgres:5499
 *
 * Validates Sales Receipts (handleSalesReceiptCreated callers) pipeline-only:
 *   - 4 callers no longer call handleSalesReceiptCreated directly
 *   - consolidator pending-dispatch includes 'sales_receipt'
 *   - consolidator's case 'sales_receipt' reads payload from row
 *   - SQL contract: pending sales_receipt rows pickable
 */

process.env.DATABASE_URL =
  "postgresql://postgres:sandbox@localhost:5499/medusa";

import { Client } from "pg";
import { randomUUID } from "crypto";
import * as fs from "fs";

const SANDBOX_DB = process.env.DATABASE_URL!;
const TEST_RUN_ID = `t156-${Date.now()}`;
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
  invoiceWaitingGate:
    "/home/alejo/webapps/ecopowertech-workspace/backend/src/jobs/qb-invoice-waiting-gate.ts",
  posSync:
    "/home/alejo/webapps/ecopowertech-workspace/backend/src/api/admin/pos/sync/route.ts",
  invoices:
    "/home/alejo/webapps/ecopowertech-workspace/backend/src/api/admin/invoices/route.ts",
  pipelineRetry:
    "/home/alejo/webapps/ecopowertech-workspace/backend/src/api/admin/quickbooks/pipeline/route.ts",
  consolidator:
    "/home/alejo/webapps/ecopowertech-workspace/backend/src/jobs/qb-pipeline-consolidator.ts",
};

function readFile(label: keyof typeof PATHS): string {
  return fs.readFileSync(PATHS[label], "utf-8");
}

function testStaticChecks() {
  console.log("\n=== TEST 1 — qb-invoice-waiting-gate enqueues SR ===");
  const wg = readFile("invoiceWaitingGate");
  assert(
    !/await\s+handleSalesReceiptCreated\(/.test(wg),
    "waiting-gate does NOT call handleSalesReceiptCreated"
  );
  assert(
    /step:\s*"sales_receipt"/.test(wg),
    "waiting-gate enqueues 'sales_receipt'"
  );

  console.log("\n=== TEST 2 — pos/sync SR branch enqueues ===");
  const ps = readFile("posSync");
  assert(
    !/await\s+handleSalesReceiptCreated\(/.test(ps),
    "pos/sync does NOT call handleSalesReceiptCreated"
  );
  assert(
    /enqueueSrPos|step:\s*"sales_receipt"/.test(ps),
    "pos/sync enqueues sales_receipt"
  );

  console.log("\n=== TEST 3 — invoices route SR branch enqueues ===");
  const inv = readFile("invoices");
  assert(
    !/await\s+handleSalesReceiptCreated\(/.test(inv),
    "invoices route does NOT call handleSalesReceiptCreated"
  );
  assert(
    /enqueueSrInv|step:\s*"sales_receipt"/.test(inv),
    "invoices route enqueues sales_receipt"
  );

  console.log("\n=== TEST 4 — quickbooks/pipeline retry SR enqueues ===");
  const pr = readFile("pipelineRetry");
  const srBlock = pr.match(/case "sales_receipt":[\s\S]+?break;/);
  assert(srBlock !== null, "found sales_receipt case in retry");
  if (srBlock) {
    assert(
      !/await\s+handleSalesReceiptCreated\(/.test(srBlock[0]),
      "retry SR case does NOT call handleSalesReceiptCreated"
    );
    assert(
      /writePipelineRow|enqueueSrRetry/.test(srBlock[0]),
      "retry SR case uses enqueue"
    );
  }

  console.log("\n=== TEST 5 — Consolidator pending-dispatch + payload-aware case ===");
  const cons = readFile("consolidator");
  assert(
    /step IN \([^)]*'sales_receipt'[^)]*\)/.test(cons),
    "pending-dispatch SQL includes 'sales_receipt'"
  );
  const srCaseBlock = cons.match(/case "sales_receipt":[\s\S]+?break;\s*\}/);
  assert(srCaseBlock !== null, "found sales_receipt case in consolidator");
  if (srCaseBlock) {
    assert(
      /SELECT payload FROM qb_order_pipeline/.test(srCaseBlock[0]),
      "case 'sales_receipt' reads payload from row"
    );
    assert(
      /handleSalesReceiptCreated\(/.test(srCaseBlock[0]),
      "case 'sales_receipt' calls handleSalesReceiptCreated"
    );
  }
}

async function testEnqueueAndPickup(client: Client) {
  console.log("\n=== TEST 6 — pending sales_receipt row pickable ===");

  const orderRes = await client.query(
    `SELECT id FROM "order" WHERE deleted_at IS NULL LIMIT 1`
  );
  const orderId = orderRes.rows[0]?.id;
  if (!orderId) throw new Error("No orders in sandbox");

  const rowId = randomUUID();
  const testPayload = {
    invoice_id: `${TEST_RUN_ID}-fake-invoice`,
    items: [{ id: "item1", qty: 1 }],
    payment_method: "cash",
  };
  await client.query(
    `INSERT INTO qb_order_pipeline (id, order_id, step, status, payload, created_at, updated_at)
     VALUES ($1, $2, 'sales_receipt', 'pending', $3::jsonb, NOW(), NOW())`,
    [rowId, orderId, JSON.stringify(testPayload)]
  );
  TEST_ROW_IDS.push(rowId);

  const picked = await client.query(`
    SELECT id, step, payload FROM qb_order_pipeline
     WHERE step = 'sales_receipt'
       AND status = 'pending'
       AND id = $1
  `, [rowId]);
  assert(picked.rows.length === 1, "row inserted and queryable");
  assert(
    picked.rows[0]?.payload?.invoice_id === testPayload.invoice_id,
    "payload.invoice_id readable"
  );
  assert(
    Array.isArray(picked.rows[0]?.payload?.items),
    "payload.items readable as array"
  );

  // Verify it's also picked by the consolidator's pending-dispatch SQL
  const dispatch = await client.query(`
    SELECT id FROM qb_order_pipeline
     WHERE step IN ('estimate_cancel', 'credit_memo_mod', 'transfer_customer', 'estimate', 'sales_order', 'so_close', 'so_reopen', 'sales_receipt')
       AND status = 'pending'
       AND id = $1
  `, [rowId]);
  assert(
    dispatch.rows.length === 1,
    "row picked by pending-dispatch SQL"
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
  console.log("Section 1.5.6 integration smoke test");
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
    console.error("\n❌ 1.5.6 integration tests FAILED");
    process.exit(1);
  }
  console.log("\n🎉 1.5.6 integration tests PASSED");
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
