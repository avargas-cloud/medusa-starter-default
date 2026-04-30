/**
 * Section 1.5.7 Integration Smoke Test — sandbox postgres:5499
 *
 * Validates Invoices (handleFulfillmentCreated callers) pipeline-only:
 *   - 5 callers no longer call handleFulfillmentCreated directly
 *   - consolidator pending-dispatch includes 'invoice'
 *   - consolidator's case 'invoice' reads payload from row
 *   - SQL contract: pending invoice rows pickable
 *
 * Note: handleInvoiceVoided + updateInvoiceInQb / fetchInvoiceLines* are
 * deferred to 1.5.7b.
 */

process.env.DATABASE_URL =
  "postgresql://postgres:sandbox@localhost:5499/medusa";

import { Client } from "pg";
import { randomUUID } from "crypto";
import * as fs from "fs";

const SANDBOX_DB = process.env.DATABASE_URL!;
const TEST_RUN_ID = `t157-${Date.now()}`;
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
    "/home/alejo/webapps/ecopowertech-workspace/backend/src/subscribers/qb-order-subscriber.ts",
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
  console.log("\n=== TEST 1 — qb-order-subscriber enqueues invoice for events ===");
  const sub = readFile("subscriber");
  // Use a non-greedy match up to the NEXT case keyword (since case bodies have
  // nested blocks with their own break;) — split the file on case labels first.
  const ffCaseStart = sub.indexOf('case "order.fulfillment_created":');
  const ffCaseEnd = sub.indexOf('case "pos.invoice.created":', ffCaseStart);
  const ffCaseBody = ffCaseStart >= 0 ? sub.substring(ffCaseStart, ffCaseEnd) : "";
  assert(ffCaseBody.length > 0, "found order.fulfillment_created case");
  assert(
    !/await\s+handleFulfillmentCreated\(/.test(ffCaseBody),
    "fulfillment case does NOT call handleFulfillmentCreated"
  );
  assert(
    /step:\s*"invoice"/.test(ffCaseBody),
    "fulfillment case enqueues 'invoice'"
  );
  const posInvCase = sub.match(/case "pos\.invoice\.created":[\s\S]+?break;\s*\}/);
  assert(posInvCase !== null, "found pos.invoice.created case");
  if (posInvCase) {
    assert(
      !/await\s+handleFulfillmentCreated\(/.test(posInvCase[0]),
      "pos.invoice.created does NOT call handleFulfillmentCreated"
    );
    assert(
      /step:\s*"invoice"/.test(posInvCase[0]),
      "pos.invoice.created enqueues 'invoice'"
    );
  }

  console.log("\n=== TEST 2 — qb-invoice-waiting-gate enqueues invoice ===");
  const wg = readFile("invoiceWaitingGate");
  assert(
    !/await\s+handleFulfillmentCreated\(/.test(wg),
    "waiting-gate does NOT call handleFulfillmentCreated"
  );
  // It enqueues both sales_receipt (1.5.6) and invoice (1.5.7) branches
  assert(
    /enqueueInvWg|step:\s*"invoice"/.test(wg),
    "waiting-gate enqueues 'invoice' branch"
  );

  console.log("\n=== TEST 3 — pos/sync invoice branch enqueues ===");
  const ps = readFile("posSync");
  assert(
    !/await\s+handleFulfillmentCreated\(/.test(ps),
    "pos/sync does NOT call handleFulfillmentCreated"
  );
  assert(
    /enqueueInvPos/.test(ps),
    "pos/sync invoice branch uses enqueue"
  );

  console.log("\n=== TEST 4 — invoices route invoice branch enqueues ===");
  const inv = readFile("invoices");
  assert(
    !/await\s+handleFulfillmentCreated\(/.test(inv),
    "invoices route does NOT call handleFulfillmentCreated"
  );
  assert(
    /enqueueInvR/.test(inv),
    "invoices route invoice branch uses enqueue"
  );

  console.log("\n=== TEST 5 — quickbooks/pipeline retry invoice case enqueues ===");
  const pr = readFile("pipelineRetry");
  const invBlock = pr.match(/case "invoice":[\s\S]+?break;/);
  assert(invBlock !== null, "found invoice case in retry");
  if (invBlock) {
    assert(
      !/await\s+handleFulfillmentCreated\(/.test(invBlock[0]),
      "retry invoice case does NOT call handleFulfillmentCreated"
    );
    assert(
      /writePipelineRow|enqueueInvRetry/.test(invBlock[0]),
      "retry invoice case uses enqueue"
    );
  }

  console.log("\n=== TEST 6 — Consolidator pending-dispatch + payload-aware case ===");
  const cons = readFile("consolidator");
  assert(
    /step IN \([^)]*'invoice'[^)]*\)/.test(cons),
    "pending-dispatch SQL includes 'invoice'"
  );
  const invCaseBlock = cons.match(/case "invoice":[\s\S]+?break;\s*\}/);
  assert(invCaseBlock !== null, "found invoice case in consolidator");
  if (invCaseBlock) {
    assert(
      /SELECT payload FROM qb_order_pipeline/.test(invCaseBlock[0]),
      "case 'invoice' reads payload from row"
    );
    assert(
      /handleFulfillmentCreated\(/.test(invCaseBlock[0]),
      "case 'invoice' calls handleFulfillmentCreated"
    );
  }
}

async function testEnqueueAndPickup(client: Client) {
  console.log("\n=== TEST 7 — pending invoice row pickable + payload roundtrip ===");

  const orderRes = await client.query(
    `SELECT id FROM "order" WHERE deleted_at IS NULL LIMIT 1`
  );
  const orderId = orderRes.rows[0]?.id;
  if (!orderId) throw new Error("No orders in sandbox");

  const rowId = randomUUID();
  const testPayload = {
    invoice_id: `${TEST_RUN_ID}-fake-invoice`,
    items: [{ id: "item1", qty: 1 }],
    fulfillment_id: `${TEST_RUN_ID}-fake-fulfill`,
  };
  await client.query(
    `INSERT INTO qb_order_pipeline (id, order_id, step, status, payload, created_at, updated_at)
     VALUES ($1, $2, 'invoice', 'pending', $3::jsonb, NOW(), NOW())`,
    [rowId, orderId, JSON.stringify(testPayload)]
  );
  TEST_ROW_IDS.push(rowId);

  const dispatch = await client.query(`
    SELECT id, payload FROM qb_order_pipeline
     WHERE step IN ('estimate_cancel', 'credit_memo_mod', 'transfer_customer', 'estimate', 'sales_order', 'so_close', 'so_reopen', 'sales_receipt', 'invoice')
       AND status = 'pending'
       AND id = $1
  `, [rowId]);
  assert(dispatch.rows.length === 1, "row picked by pending-dispatch SQL");
  assert(
    dispatch.rows[0]?.payload?.invoice_id === testPayload.invoice_id,
    "payload.invoice_id readable"
  );
  assert(
    dispatch.rows[0]?.payload?.fulfillment_id === testPayload.fulfillment_id,
    "payload.fulfillment_id readable"
  );
  assert(
    Array.isArray(dispatch.rows[0]?.payload?.items),
    "payload.items readable as array"
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
  console.log("Section 1.5.7 integration smoke test");
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
    console.error("\n❌ 1.5.7 integration tests FAILED");
    process.exit(1);
  }
  console.log("\n🎉 1.5.7 integration tests PASSED");
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
