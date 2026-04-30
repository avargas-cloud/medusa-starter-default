/**
 * Section 1.5.9 Integration Smoke Test — sandbox postgres:5499
 *
 * Validates Payments (handlePosPaymentCreated + handlePosPaymentApplied)
 * pipeline-only:
 *   - 5 callers no longer call these handlers directly
 *   - consolidator pending-dispatch includes 'payment' + 'apply_payment'
 *   - consolidator has case 'payment' (CREATE) + existing 'apply_payment'
 *   - SQL contract: pending payment + apply_payment rows pickable
 *
 * Deferred to 1.5.9b:
 *   - handlePosPaymentVoided, handlePosPaymentUnapplied
 *   - handleCustomerPaymentApplied, handlePaymentCaptured (web)
 */

process.env.DATABASE_URL =
  "postgresql://postgres:sandbox@localhost:5499/medusa";

import { Client } from "pg";
import { randomUUID } from "crypto";
import * as fs from "fs";

const SANDBOX_DB = process.env.DATABASE_URL!;
const TEST_RUN_ID = `t159-${Date.now()}`;
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
  posSync:
    "/home/alejo/webapps/ecopowertech-workspace/backend/src/jobs/qb-pos-sync.ts",
  invoiceWaitingGate:
    "/home/alejo/webapps/ecopowertech-workspace/backend/src/jobs/qb-invoice-waiting-gate.ts",
  finPayments:
    "/home/alejo/webapps/ecopowertech-workspace/backend/src/api/admin/finance/payments/route.ts",
  finApply:
    "/home/alejo/webapps/ecopowertech-workspace/backend/src/api/admin/finance/payments/[id]/apply/route.ts",
  posSyncRoute:
    "/home/alejo/webapps/ecopowertech-workspace/backend/src/api/admin/pos/sync/route.ts",
};

function readFile(label: keyof typeof PATHS): string {
  return fs.readFileSync(PATHS[label], "utf-8");
}

function testStaticChecks() {
  console.log("\n=== TEST 1 — qb-pos-sync auto-retry resets to pending ===");
  const ps = readFile("posSync");
  assert(
    !/await\s+handlePosPaymentCreated\(/.test(ps),
    "qb-pos-sync does NOT call handlePosPaymentCreated"
  );
  assert(
    /SET status = 'pending', error = NULL/.test(ps),
    "qb-pos-sync resets row to 'pending' for retry"
  );

  console.log("\n=== TEST 2 — qb-invoice-waiting-gate enqueues payment + apply_payment ===");
  const wg = readFile("invoiceWaitingGate");
  assert(
    !/await\s+handlePosPaymentCreated\(/.test(wg),
    "waiting-gate does NOT call handlePosPaymentCreated"
  );
  assert(
    !/await\s+handlePosPaymentApplied\(/.test(wg),
    "waiting-gate does NOT call handlePosPaymentApplied"
  );
  assert(
    /step:\s*"payment"/.test(wg),
    "waiting-gate enqueues 'payment'"
  );
  assert(
    /step:\s*"apply_payment"/.test(wg),
    "waiting-gate enqueues 'apply_payment'"
  );

  console.log("\n=== TEST 3 — finance/payments route enqueues payment ===");
  const fp = readFile("finPayments");
  assert(
    !/await\s+handlePosPaymentCreated\(/.test(fp),
    "finance/payments does NOT call handlePosPaymentCreated"
  );
  assert(
    /step:\s*"payment"/.test(fp),
    "finance/payments enqueues 'payment'"
  );

  console.log("\n=== TEST 4 — finance/payments/apply route enqueues apply_payment ===");
  const fa = readFile("finApply");
  assert(
    !/await\s+handlePosPaymentApplied\(/.test(fa),
    "finance/apply does NOT call handlePosPaymentApplied"
  );
  assert(
    /step:\s*"apply_payment"/.test(fa),
    "finance/apply enqueues 'apply_payment'"
  );

  console.log("\n=== TEST 5 — pos/sync route enqueues payment + apply_payment ===");
  const psr = readFile("posSyncRoute");
  assert(
    !/await\s+handlePosPaymentCreated\(/.test(psr),
    "pos/sync does NOT call handlePosPaymentCreated"
  );
  assert(
    !/await\s+handlePosPaymentApplied\(/.test(psr),
    "pos/sync does NOT call handlePosPaymentApplied"
  );
  assert(
    /enqueuePosPay/.test(psr),
    "pos/sync uses enqueuePosPay"
  );

  console.log("\n=== TEST 6 — Consolidator extensions ===");
  const cons = readFile("consolidator");
  assert(
    /step IN \([^)]*'payment'[^)]*\)/.test(cons),
    "pending-dispatch SQL includes 'payment'"
  );
  assert(
    /step IN \([^)]*'apply_payment'[^)]*\)/.test(cons),
    "pending-dispatch SQL includes 'apply_payment'"
  );
  // Find case "payment": { ... break; } using slicing
  const payStart = cons.indexOf('case "payment":');
  const payNext = cons.indexOf('case "', payStart + 1);
  const payBody = cons.substring(payStart, payNext);
  assert(
    /handlePosPaymentCreated/.test(payBody),
    "case 'payment' calls handlePosPaymentCreated"
  );
  const applyStart = cons.indexOf('case "apply_payment":');
  const applyNext = cons.indexOf('case "', applyStart + 1);
  const applyBody = cons.substring(applyStart, applyNext);
  assert(
    /handlePosPaymentApplied/.test(applyBody),
    "case 'apply_payment' calls handlePosPaymentApplied"
  );
}

async function testEnqueueAndPickup(client: Client) {
  console.log("\n=== TEST 7 — pending payment + apply_payment rows pickable ===");

  const orderRes = await client.query(
    `SELECT id FROM "order" WHERE deleted_at IS NULL LIMIT 1`
  );
  const orderId = orderRes.rows[0]?.id;
  if (!orderId) throw new Error("No orders in sandbox");

  for (const step of ["payment", "apply_payment"]) {
    const rowId = randomUUID();
    const payload =
      step === "apply_payment"
        ? {
            payment_id: `${TEST_RUN_ID}-fake-pay`,
            invoice_id: `${TEST_RUN_ID}-fake-inv`,
            order_id: orderId,
            amount_applied: 100,
          }
        : {};
    await client.query(
      `INSERT INTO qb_order_pipeline (id, order_id, reference_id, reference_type, step, status, payload, created_at, updated_at)
       VALUES ($1, $2, $3, 'payment', $4, 'pending', $5::jsonb, NOW(), NOW())`,
      [
        rowId,
        orderId,
        `${TEST_RUN_ID}-fake-pay-${step}`,
        step,
        JSON.stringify(payload),
      ]
    );
    TEST_ROW_IDS.push(rowId);
  }

  const dispatch = await client.query(`
    SELECT id, step FROM qb_order_pipeline
     WHERE step IN ('estimate_cancel', 'credit_memo_mod', 'transfer_customer', 'estimate', 'sales_order', 'so_close', 'so_reopen', 'sales_receipt', 'invoice', 'credit_memo', 'void_credit_memo', 'payment', 'apply_payment')
       AND status = 'pending'
       AND id = ANY($1::uuid[])
  `, [TEST_ROW_IDS]);
  assert(
    dispatch.rows.length === 2,
    `pending-dispatch picks up both rows (got ${dispatch.rows.length})`
  );
  const steps = dispatch.rows.map((r) => r.step).sort();
  assert(
    JSON.stringify(steps) === JSON.stringify(["apply_payment", "payment"]),
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
  console.log("Section 1.5.9 integration smoke test");
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
    console.error("\n❌ 1.5.9 integration tests FAILED");
    process.exit(1);
  }
  console.log("\n🎉 1.5.9 integration tests PASSED");
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
