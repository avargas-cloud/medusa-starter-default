/**
 * Section 1.5.14 — Void/Cancel Pipeline Migration
 *
 * Validates that all void/cancel paths enqueue rows in qb_order_pipeline
 * with status='pending' instead of calling qb-bridge-client directly.
 *
 * Test layers:
 *   A) Static — no direct void/close bridge calls outside consolidator
 *   B) Consolidator submit — resubmit-by-step.ts handles void_invoice,
 *      void_sales_receipt, void_check
 *   C) Post-confirm — poll-submitted-rows.ts updates metadata for void steps
 *   D) Retry — post-pipeline.ts has retry cases for new void steps
 *   E) Legacy — sales-receipt/route.ts deleted
 *   F) State machine — void rows can be enqueued as pending
 */

process.env.DATABASE_URL =
  "postgresql://postgres:sandbox@localhost:5499/medusa";

import { Client } from "pg";
import * as fs from "fs";
import * as path from "path";

const SANDBOX_DB = process.env.DATABASE_URL!;
const TEST_RUN_ID = `t1514-${Date.now()}`;
const TEST_ROW_IDS: string[] = [];

let pass = 0;
let fail = 0;
const SECTION_RESULTS: Record<string, { pass: number; fail: number }> = {};
let currentSection = "general";

function setSection(name: string) {
  currentSection = name;
  SECTION_RESULTS[name] = { pass: 0, fail: 0 };
}

function assert(cond: boolean, label: string, detail?: string) {
  if (cond) {
    console.log(`  ✅ ${label}`);
    pass++;
    SECTION_RESULTS[currentSection].pass++;
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
    fail++;
    SECTION_RESULTS[currentSection].fail++;
  }
}

const BACKEND_SRC = path.resolve(__dirname, "../..");
function read(rel: string): string {
  const abs = path.join(BACKEND_SRC, rel);
  if (!fs.existsSync(abs)) return "";
  return fs.readFileSync(abs, "utf8");
}
function fileExists(rel: string): boolean {
  return fs.existsSync(path.join(BACKEND_SRC, rel));
}

// ─── A) Static — no direct void/close bridge calls outside consolidator ────
function testNoDirectVoidCalls() {
  setSection("A — No direct void/close bridge calls");
  console.log(`\n=== ${currentSection} ===`);

  const FORBIDDEN_FILES_AND_FNS: Array<[string, string[]]> = [
    [
      "lib/quickbooks/handlers/handle-invoice-voided.ts",
      ["voidInvoiceInQb", "voidSalesReceiptInQb"],
    ],
    [
      "lib/quickbooks/handlers/handle-order-canceled.ts",
      ["voidInvoiceInQb", "closeSalesOrderInQb"],
    ],
    [
      "api/admin/finance/qb-refunds/[id]/void/route.ts",
      ["voidCheckInQb"],
    ],
  ];

  for (const [file, fns] of FORBIDDEN_FILES_AND_FNS) {
    const src = read(file);
    if (!src) {
      assert(false, `${file} exists`, "file not found");
      continue;
    }
    for (const fn of fns) {
      const directCallPattern = new RegExp(`await\\s+${fn}\\(`);
      const importPattern = new RegExp(
        `import[^;]*\\b${fn}\\b[^;]*from[^;]*qb-bridge-client`
      );
      const importFromClient = new RegExp(
        `import[^;]*\\b${fn}\\b[^;]*from[^;]*client/`
      );
      const hasDirect = directCallPattern.test(src);
      const hasImport =
        importPattern.test(src) || importFromClient.test(src);
      assert(
        !hasDirect,
        `${file.split("/").slice(-2).join("/")}: no direct ${fn}() call`
      );
      assert(
        !hasImport,
        `${file.split("/").slice(-2).join("/")}: no import of ${fn}`
      );
    }
  }
}

// ─── B) Consolidator submit handlers exist for new void steps ───────────────
function testConsolidatorSubmitHandlers() {
  setSection("B — Consolidator submit handlers");
  console.log(`\n=== ${currentSection} ===`);

  const src = read("lib/quickbooks/consolidator/resubmit-by-step.ts");
  const REQUIRED_CASES = ["void_invoice", "void_sales_receipt", "void_check"];

  for (const step of REQUIRED_CASES) {
    const casePattern = new RegExp(`case\\s+["']${step}["']`);
    assert(
      casePattern.test(src),
      `resubmit-by-step.ts: case "${step}" handler exists`
    );
  }

  // Each handler must call the corresponding bridge fn (consolidator IS allowed)
  const REQUIRED_BRIDGE_CALLS = [
    "voidInvoiceInQb",
    "voidSalesReceiptInQb",
    "voidCheckInQb",
  ];
  for (const fn of REQUIRED_BRIDGE_CALLS) {
    const callPattern = new RegExp(`\\b${fn}\\b`);
    assert(
      callPattern.test(src),
      `resubmit-by-step.ts: invokes ${fn} (consolidator path)`
    );
  }

  // Critical: dispatch-pass SQL must include new steps so consolidator picks
  // them up — otherwise pending rows go nowhere and the migration silently
  // breaks the void flow.
  const dispatch = read("lib/quickbooks/consolidator/dispatch-pass.ts");
  for (const step of REQUIRED_CASES) {
    assert(
      new RegExp(`step IN \\([^)]*'${step}'[^)]*\\)`).test(dispatch),
      `dispatch-pass.ts: pending-dispatch SQL includes '${step}'`
    );
  }
}

// ─── C) Post-confirm metadata sync for void steps ───────────────────────────
function testPostConfirmSync() {
  setSection("C — Post-confirm metadata sync");
  console.log(`\n=== ${currentSection} ===`);

  const src = read("lib/quickbooks/consolidator/poll-submitted-rows.ts");
  const REQUIRED_REFS = [
    "void_invoice",
    "void_sales_receipt",
    "void_check",
  ];

  for (const step of REQUIRED_REFS) {
    assert(
      src.includes(step),
      `poll-submitted-rows.ts: references "${step}" step`
    );
  }

  // Should write voided_in_qb status (or equivalent) to pos_invoice metadata
  assert(
    /voided_in_qb|qb_sync_status\s*=\s*['"]voided/.test(src),
    `poll-submitted-rows.ts: updates pos_invoice qb_sync_status post-confirm`
  );
}

// ─── D) Retry handlers in post-pipeline.ts ──────────────────────────────────
function testRetryHandlers() {
  setSection("D — Retry handlers (post-pipeline.ts)");
  console.log(`\n=== ${currentSection} ===`);

  const src = read(
    "api/admin/quickbooks/pipeline/handlers/post-pipeline.ts"
  );
  const REQUIRED_CASES = ["void_invoice", "void_sales_receipt", "void_check"];

  for (const step of REQUIRED_CASES) {
    const casePattern = new RegExp(`case\\s+["']${step}["']`);
    assert(
      casePattern.test(src),
      `post-pipeline.ts: retry case "${step}" exists`
    );
  }
}

// ─── E) Legacy SR admin route deleted ───────────────────────────────────────
function testLegacyRouteDeleted() {
  setSection("E — Legacy sales-receipt route deleted");
  console.log(`\n=== ${currentSection} ===`);

  assert(
    !fileExists("api/admin/quickbooks/sales-receipt/route.ts"),
    "api/admin/quickbooks/sales-receipt/route.ts: deleted"
  );
}

// ─── F) State machine — void rows can be enqueued as pending ────────────────
async function testStateMachine() {
  setSection("F — Pipeline state machine for void steps");
  console.log(`\n=== ${currentSection} ===`);

  const client = new Client({ connectionString: SANDBOX_DB });
  await client.connect();

  try {
    const synthOrderId = `order_${TEST_RUN_ID}_void`;

    // Insert a synthetic void_invoice pending row
    const insertSql = `
      INSERT INTO qb_order_pipeline (
        id, order_id, step, status, qb_txn_id, qb_ref_number,
        medusa_ref_number, retry_count, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), $1, $2, 'pending',
        'TEST-TXN-${TEST_RUN_ID}', 'TEST-REF',
        'TEST-MED', 0, NOW(), NOW()
      )
      RETURNING id::text
    `;

    const inv = await client.query(insertSql, [synthOrderId, "void_invoice"]);
    TEST_ROW_IDS.push(inv.rows[0].id);
    assert(
      !!inv.rows[0]?.id,
      `void_invoice pending row inserted (id=${inv.rows[0]?.id})`
    );

    const sr = await client.query(insertSql, [
      synthOrderId,
      "void_sales_receipt",
    ]);
    TEST_ROW_IDS.push(sr.rows[0].id);
    assert(
      !!sr.rows[0]?.id,
      `void_sales_receipt pending row inserted (id=${sr.rows[0]?.id})`
    );

    const chk = await client.query(insertSql, [synthOrderId, "void_check"]);
    TEST_ROW_IDS.push(chk.rows[0].id);
    assert(
      !!chk.rows[0]?.id,
      `void_check pending row inserted (id=${chk.rows[0]?.id})`
    );

    // Verify all three are queryable as pending
    const { rows } = await client.query(
      `SELECT step FROM qb_order_pipeline
       WHERE order_id=$1 AND status='pending' ORDER BY step`,
      [synthOrderId]
    );
    const steps = rows.map((r: { step: string }) => r.step).sort();
    assert(
      JSON.stringify(steps) ===
        JSON.stringify(["void_check", "void_invoice", "void_sales_receipt"]),
      `all three void steps queryable as pending (${steps.join(", ")})`
    );
  } finally {
    // Cleanup
    if (TEST_ROW_IDS.length) {
      await client.query(
        `DELETE FROM qb_order_pipeline WHERE id::text = ANY($1::text[])`,
        [TEST_ROW_IDS]
      );
    }
    await client.end();
  }
}

// ─── Orchestrator ───────────────────────────────────────────────────────────
async function main() {
  console.log("\n╭─ Section 1.5.14 — Void/Cancel Pipeline Migration ─╮");
  console.log(`│  Run ID: ${TEST_RUN_ID}`);
  console.log(`│  DB: ${SANDBOX_DB}`);
  console.log("╰────────────────────────────────────────────────────╯\n");

  testNoDirectVoidCalls();
  testConsolidatorSubmitHandlers();
  testPostConfirmSync();
  testRetryHandlers();
  testLegacyRouteDeleted();
  await testStateMachine();

  console.log("\n╭─ Section Results ─────────────────────────────────╮");
  for (const [name, r] of Object.entries(SECTION_RESULTS)) {
    const status = r.fail === 0 ? "✅" : "❌";
    console.log(`│  ${status} ${name}: ${r.pass}/${r.pass + r.fail}`);
  }
  console.log(`├───────────────────────────────────────────────────`);
  console.log(`│  TOTAL: ${pass}/${pass + fail}`);
  console.log("╰────────────────────────────────────────────────────╯\n");

  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n❌ FATAL:", err);
  process.exit(2);
});
