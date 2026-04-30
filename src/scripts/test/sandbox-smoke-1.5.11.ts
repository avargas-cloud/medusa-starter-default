/**
 * Section 1.5.11 — client/* @internal documentation cleanup.
 *
 * This sub-phase doesn't change runtime behavior. It documents the
 * unified-pipeline architecture invariant via JSDoc on the client barrel.
 *
 * Sandbox check: confirm the @internal header is in place and the file
 * still compiles + still re-exports the right surface.
 */

process.env.DATABASE_URL =
  "postgresql://postgres:sandbox@localhost:5499/medusa";

import * as fs from "fs";

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

const INDEX_PATH =
  "/home/alejo/webapps/ecopowertech-workspace/backend/src/lib/quickbooks/client/index.ts";

async function main() {
  console.log("Section 1.5.11 integration smoke test\n");

  console.log("=== TEST 1 — @internal header present ===");
  const src = fs.readFileSync(INDEX_PATH, "utf-8");
  assert(/@internal Bridge-ops client surface/.test(src), "header present");
  assert(
    /enqueue a `qb_order_pipeline` row/.test(src),
    "header explains enqueue rule"
  );
  assert(
    /qb-pipeline-consolidator\.ts/.test(src),
    "header names canonical caller"
  );

  console.log("\n=== TEST 2 — barrel still exports all client modules ===");
  const expectedExports = [
    "./types",
    "./core",
    "./customers",
    "./estimates",
    "./invoices",
    "./payments",
    "./sales-orders",
    "./sales-receipts",
    "./transfer",
    "./credit-memos",
    "./checks",
    "./refunds",
  ];
  for (const ex of expectedExports) {
    assert(
      new RegExp(`export \\* from "${ex.replace(/\//g, "\\/")}"`).test(src),
      `re-exports '${ex}'`
    );
  }

  console.log("\n=== TEST 3 — barrel still importable at runtime ===");
  const barrel = await import("../../lib/quickbooks/client");
  assert(typeof barrel === "object", "barrel imports without error");
  assert(
    typeof (barrel as any).bridgeFetch === "function",
    "core exports still accessible (bridgeFetch)"
  );
  assert(
    typeof (barrel as any).createInvoiceInQb === "function",
    "client functions still accessible (createInvoiceInQb)"
  );
  assert(
    (barrel as any).adjustInventoryInQb === undefined,
    "previously-deleted (1.5.2) adjustInventoryInQb stays gone"
  );

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Pass: ${pass}  /  Fail: ${fail}`);
  console.log("=".repeat(50));

  if (fail > 0) {
    console.error("\n❌ 1.5.11 integration tests FAILED");
    process.exit(1);
  }
  console.log("\n🎉 1.5.11 integration tests PASSED");
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
