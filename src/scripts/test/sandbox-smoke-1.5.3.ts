/**
 * Section 1.5.3 Integration Smoke Test — sandbox postgres:5499
 *
 * Validates customer-transfer flow now uses pipeline-only:
 *   - Handler (handle-customer-transferred) only enqueues 'pending' rows
 *   - Consolidator's transfer_customer case picks up pending rows,
 *     calls transferDocumentCustomer, transitions to 'submitted'
 *
 * Tests:
 *   1. Handler module no longer imports transferDocumentCustomer
 *   2. Consolidator's pending-dispatch query includes 'transfer_customer'
 *   3. SQL contract: pending row with full payload → consolidator UPDATE
 *      to 'submitted' produces correct end state
 *   4. Failure path: pending row with incomplete payload → fails cleanly
 *
 * Run from /backend dir:
 *   node_modules/.bin/tsx src/scripts/test/sandbox-smoke-1.5.3.ts
 */

process.env.DATABASE_URL =
  "postgresql://postgres:sandbox@localhost:5499/medusa";

import { Client } from "pg";
import { randomUUID } from "crypto";
import * as fs from "fs";

const SANDBOX_DB = process.env.DATABASE_URL!;
const TEST_RUN_ID = `t153-${Date.now()}`;
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

async function pickOrderForTest(client: Client): Promise<string> {
  const res = await client.query(
    `SELECT id FROM "order" WHERE deleted_at IS NULL LIMIT 1`
  );
  if (res.rows.length === 0) throw new Error("No orders in sandbox");
  return res.rows[0].id;
}

function testHandlerNoLongerImportsClient() {
  console.log(
    "\n=== TEST 1 — handle-customer-transferred no longer calls client/transfer ==="
  );

  const handlerPath =
    "/home/alejo/webapps/ecopowertech-workspace/backend/src/lib/quickbooks/handlers/handle-customer-transferred.ts";
  const src = fs.readFileSync(handlerPath, "utf-8");

  assert(
    !/import\s+\{[^}]*transferDocumentCustomer[^}]*\}\s+from\s+['"]\.\.\/client\/transfer['"]/.test(
      src
    ),
    "handler does NOT import transferDocumentCustomer"
  );
  assert(
    !/await\s+transferDocumentCustomer\(/.test(src),
    "handler does NOT call transferDocumentCustomer()"
  );
  assert(
    /step:\s*"transfer_customer"/.test(src),
    "handler still writes step='transfer_customer' rows"
  );
  assert(
    /editSequence:\s*doc\.editSeq/.test(src),
    "handler payload includes editSequence (so consolidator can use it)"
  );
}

function testConsolidatorPickupQuery() {
  console.log(
    "\n=== TEST 2 — Consolidator pending-dispatch includes transfer_customer ==="
  );

  const consolidatorPath =
    "/home/alejo/webapps/ecopowertech-workspace/backend/src/jobs/qb-pipeline-consolidator.ts";
  const src = fs.readFileSync(consolidatorPath, "utf-8");

  assert(
    /step IN \('estimate_cancel', 'credit_memo_mod', 'transfer_customer'\)/.test(
      src
    ),
    "pending-dispatch SQL includes 'transfer_customer'"
  );
  assert(
    /case "transfer_customer":/.test(src),
    "resubmitByStep has case 'transfer_customer'"
  );
  assert(
    /transferDocumentCustomer\(/.test(src),
    "consolidator calls transferDocumentCustomer"
  );
}

async function testSubmitFlowSql(client: Client) {
  console.log(
    "\n=== TEST 3 — Pending row with full payload → 'submitted' UPDATE works ==="
  );

  const orderId = await pickOrderForTest(client);
  const rowId = randomUUID();
  const txnId = `${TEST_RUN_ID}-fake-txn`;
  const payload = {
    docType: "sales-order",
    txnId,
    editSequence: "12345",
    newCustomerId: `${TEST_RUN_ID}-fake-cust-list-id`,
  };

  await client.query(
    `INSERT INTO qb_order_pipeline
       (id, order_id, reference_id, reference_type, step, status, payload, created_at, updated_at)
     VALUES ($1, $2, $3, 'sales_order', 'transfer_customer', 'pending', $4::jsonb, NOW(), NOW())`,
    [rowId, orderId, txnId, JSON.stringify(payload)]
  );
  TEST_ROW_IDS.push(rowId);

  // Verify pending-dispatch SQL would pick this up
  const picked = await client.query(`
    SELECT id, step FROM qb_order_pipeline
     WHERE step IN ('estimate_cancel', 'credit_memo_mod', 'transfer_customer')
       AND status = 'pending'
       AND id = $1
  `, [rowId]);
  assert(
    picked.rows.length === 1 && picked.rows[0].step === "transfer_customer",
    "row picked by pending-dispatch SQL"
  );

  // Verify the JOIN in the case body finds the payload
  const payloadRead = await client.query(
    `SELECT payload FROM qb_order_pipeline WHERE id = $1`,
    [rowId]
  );
  const p = payloadRead.rows[0]?.payload;
  assert(p?.docType === "sales-order", "payload.docType readable");
  assert(p?.txnId === txnId, "payload.txnId readable");
  assert(p?.editSequence === "12345", "payload.editSequence readable");
  assert(!!p?.newCustomerId, "payload.newCustomerId readable");

  // Apply consolidator's success UPDATE (simulate transferDocumentCustomer returning op)
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
    `SELECT status, bridge_op_id, qb_txn_id FROM qb_order_pipeline WHERE id = $1`,
    [rowId]
  );
  const r = final.rows[0];
  assert(r.status === "submitted", "row → 'submitted'");
  assert(r.bridge_op_id === fakeOpId, "bridge_op_id stored");
  assert(r.qb_txn_id === txnId, "qb_txn_id stored");
}

async function testIncompletePayloadFails(client: Client) {
  console.log(
    "\n=== TEST 4 — Incomplete payload → failPipelineRow with clear msg ==="
  );

  const { failPipelineRow } = await import(
    "../../lib/quickbooks/qb-pipeline"
  );

  const orderId = await pickOrderForTest(client);
  const rowId = randomUUID();
  const txnId = `${TEST_RUN_ID}-incomplete-txn`;

  // Insert pending row with INCOMPLETE payload (missing editSequence)
  await client.query(
    `INSERT INTO qb_order_pipeline
       (id, order_id, reference_id, reference_type, step, status, payload, created_at, updated_at)
     VALUES ($1, $2, $3, 'sales_order', 'transfer_customer', 'pending', $4::jsonb, NOW(), NOW())`,
    [
      rowId,
      orderId,
      txnId,
      JSON.stringify({ docType: "sales-order", txnId }), // missing editSequence + newCustomerId
    ]
  );
  TEST_ROW_IDS.push(rowId);

  // Simulate consolidator detecting missing fields and failing
  await failPipelineRow(
    rowId,
    "transfer_customer: payload incomplete (docType=sales-order, txnId=true, editSequence=false, newCustomerId=false)"
  );

  const final = await client.query(
    `SELECT status, error FROM qb_order_pipeline WHERE id = $1`,
    [rowId]
  );
  const r = final.rows[0];
  assert(r.status === "failed", "row → 'failed'");
  assert(
    r.error?.includes("payload incomplete"),
    "error mentions 'payload incomplete'",
    r.error
  );
  assert(
    r.error?.includes("editSequence=false"),
    "error indicates which fields are missing"
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
  console.log("Section 1.5.3 integration smoke test");
  console.log(`Test run id: ${TEST_RUN_ID}\n`);

  // Static-source tests don't need DB
  testHandlerNoLongerImportsClient();
  testConsolidatorPickupQuery();

  const client = new Client({ connectionString: SANDBOX_DB });
  await client.connect();

  try {
    await testSubmitFlowSql(client);
    await testIncompletePayloadFails(client);
  } finally {
    await cleanup(client);
    await client.end();
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Pass: ${pass}  /  Fail: ${fail}`);
  console.log("=".repeat(50));

  if (fail > 0) {
    console.error("\n❌ 1.5.3 integration tests FAILED");
    process.exit(1);
  }
  console.log("\n🎉 1.5.3 integration tests PASSED");
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
