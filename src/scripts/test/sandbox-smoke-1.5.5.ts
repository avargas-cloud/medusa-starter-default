/**
 * Section 1.5.5 Integration Smoke Test — sandbox postgres:5499
 *
 * Validates Sales Orders pipeline-only:
 *   - subscriber, qb-pos-sync, 4 admin routes do NOT call SO handlers directly
 *   - consolidator pending-dispatch includes 'sales_order', 'so_close', 'so_reopen'
 *   - resubmitByStep has cases for so_close + so_reopen
 *   - SQL contract: pending sales_order/so_close/so_reopen rows pickable
 */

process.env.DATABASE_URL =
  "postgresql://postgres:sandbox@localhost:5499/medusa";

import { Client } from "pg";
import { randomUUID } from "crypto";
import * as fs from "fs";

const SANDBOX_DB = process.env.DATABASE_URL!;
const TEST_RUN_ID = `t155-${Date.now()}`;
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
  posSync:
    "/home/alejo/webapps/ecopowertech-workspace/backend/src/jobs/qb-pos-sync.ts",
  consolidator:
    "/home/alejo/webapps/ecopowertech-workspace/backend/src/jobs/qb-pipeline-consolidator.ts",
  toggleClose:
    "/home/alejo/webapps/ecopowertech-workspace/backend/src/api/admin/orders/[id]/toggle-close/route.ts",
  posSyncRoute:
    "/home/alejo/webapps/ecopowertech-workspace/backend/src/api/admin/pos/sync/route.ts",
  pipelineRetry:
    "/home/alejo/webapps/ecopowertech-workspace/backend/src/api/admin/quickbooks/pipeline/route.ts",
};

function readFile(label: keyof typeof PATHS): string {
  return fs.readFileSync(PATHS[label], "utf-8");
}

function testStaticChecks() {
  console.log("\n=== TEST 1 — Subscriber order.placed enqueues, doesn't call handleOrderPlaced ===");
  const sub = readFile("subscriber");
  const orderPlacedBlock = sub.match(
    /case "order\.placed":[\s\S]+?break;/
  );
  assert(orderPlacedBlock !== null, "found order.placed case");
  if (orderPlacedBlock) {
    assert(
      !/await\s+handleOrderPlaced\(/.test(orderPlacedBlock[0]),
      "order.placed does NOT call handleOrderPlaced()"
    );
    assert(
      /writePipelineRow\(/.test(orderPlacedBlock[0]) &&
        /step:\s*"sales_order"/.test(orderPlacedBlock[0]),
      "order.placed enqueues sales_order"
    );
  }

  console.log("\n=== TEST 2 — qb-pos-sync enqueues SO instead of calling handler ===");
  const pos = readFile("posSync");
  assert(
    !/await\s+handleOrderPlaced\(/.test(pos),
    "qb-pos-sync does NOT call handleOrderPlaced"
  );
  assert(
    /step:\s*"sales_order"/.test(pos),
    "qb-pos-sync enqueues sales_order"
  );

  console.log("\n=== TEST 3 — toggle-close uses enqueue, not closeSalesOrderInQb/reopenSalesOrderInQb ===");
  const tc = readFile("toggleClose");
  assert(
    !/await\s+closeSalesOrderInQb\(/.test(tc),
    "toggle-close does NOT call closeSalesOrderInQb"
  );
  assert(
    !/await\s+reopenSalesOrderInQb\(/.test(tc),
    "toggle-close does NOT call reopenSalesOrderInQb"
  );
  assert(/writePipelineRow\(/.test(tc), "toggle-close uses writePipelineRow");

  console.log("\n=== TEST 4 — pos/sync/route SO branch enqueues, doesn't call handleOrderPlaced ===");
  const pr = readFile("posSyncRoute");
  // pos/sync still has handleOrderCanceled call (deferred to 1.5.5b);
  // we only check handleOrderPlaced is gone
  assert(
    !/await\s+handleOrderPlaced\(/.test(pr),
    "pos/sync does NOT call handleOrderPlaced"
  );

  console.log("\n=== TEST 5 — quickbooks/pipeline retry SO case enqueues ===");
  const re = readFile("pipelineRetry");
  // Check that the sales_order case in retry doesn't call handleOrderPlaced/Updated directly
  const soCaseBlock = re.match(/case "sales_order":[\s\S]+?break;/);
  assert(soCaseBlock !== null, "found sales_order case in retry");
  if (soCaseBlock) {
    assert(
      !/await\s+handleOrderUpdated\(/.test(soCaseBlock[0]) &&
        !/await\s+handleOrderPlaced\(/.test(soCaseBlock[0]),
      "retry SO case does NOT call handleOrder* directly"
    );
    assert(
      /writePipelineRow|enqueue/.test(soCaseBlock[0]),
      "retry SO case uses enqueue"
    );
  }

  console.log("\n=== TEST 6 — consolidator extensions ===");
  const cons = readFile("consolidator");
  assert(
    /step IN \([^)]*'sales_order'[^)]*\)/.test(cons),
    "pending-dispatch SQL includes 'sales_order'"
  );
  assert(
    /step IN \([^)]*'so_close'[^)]*\)/.test(cons),
    "pending-dispatch SQL includes 'so_close'"
  );
  assert(
    /step IN \([^)]*'so_reopen'[^)]*\)/.test(cons),
    "pending-dispatch SQL includes 'so_reopen'"
  );
  assert(
    /case "so_close":/.test(cons),
    "resubmitByStep has case 'so_close'"
  );
  assert(
    /case "so_reopen":/.test(cons),
    "resubmitByStep has case 'so_reopen'"
  );
  assert(
    /closeSalesOrderInQb\(soTxnId/.test(cons),
    "consolidator calls closeSalesOrderInQb"
  );
}

async function testEnqueueAndPickup(client: Client) {
  console.log(
    "\n=== TEST 7 — pending sales_order/so_close/so_reopen pickable ==="
  );

  const orderRes = await client.query(
    `SELECT id FROM "order" WHERE deleted_at IS NULL LIMIT 1`
  );
  const orderId = orderRes.rows[0]?.id;
  if (!orderId) throw new Error("No orders in sandbox");

  // Insert one of each step in 'pending'
  for (const step of ["sales_order", "so_close", "so_reopen"]) {
    const rowId = randomUUID();
    await client.query(
      `INSERT INTO qb_order_pipeline (id, order_id, step, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'pending', NOW(), NOW())`,
      [rowId, orderId, step]
    );
    TEST_ROW_IDS.push(rowId);
  }

  const picked = await client.query(`
    SELECT id, step FROM qb_order_pipeline
     WHERE step IN ('estimate_cancel', 'credit_memo_mod', 'transfer_customer', 'estimate', 'sales_order', 'so_close', 'so_reopen')
       AND status = 'pending'
       AND id = ANY($1::uuid[])
  `, [TEST_ROW_IDS]);

  assert(
    picked.rows.length === 3,
    `picked all 3 rows (got ${picked.rows.length})`
  );
  const steps = picked.rows.map((r) => r.step).sort();
  assert(
    JSON.stringify(steps) ===
      JSON.stringify(["sales_order", "so_close", "so_reopen"]),
    "picked correct 3 step types"
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
  console.log("Section 1.5.5 integration smoke test");
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
    console.error("\n❌ 1.5.5 integration tests FAILED");
    process.exit(1);
  }
  console.log("\n🎉 1.5.5 integration tests PASSED");
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
