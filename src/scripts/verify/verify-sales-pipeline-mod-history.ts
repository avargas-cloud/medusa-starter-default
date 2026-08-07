/**
 * verify-sales-pipeline-mod-history.ts — gate of the append-only sales lane.
 *
 * Asserts that every sales MOD step is registered in EVERY layer of the
 * control plane. A step registered in some layers but not others is exactly
 * how "Failed 5 over a list of 1" (badge scope) and the silent-drop of order
 * 2450 happened — the lists live in different files and nothing ties them.
 *
 * Plain tsx script (NOT medusa exec — no `export default`):
 *   ./node_modules/.bin/tsx src/scripts/verify/verify-sales-pipeline-mod-history.ts
 *
 * SOURCE_ROOT overrides the scanned source tree (mutation-testing the gate).
 *
 * (2026-08-07: Railway solo construye si el commit toca /src/** — este archivo
 * sirvió de trigger cuando el builder Metal colgó el build de 85b80b13.)
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = process.env.SOURCE_ROOT
  ? path.resolve(process.env.SOURCE_ROOT)
  : path.resolve(__dirname, "../..");

const SALES_MOD_STEPS = [
  "estimate_mod",
  "sales_order_mod",
  "invoice_update",
  "sales_receipt_update",
  "credit_memo_mod",
  "payment_method_change",
  "payment_txndate_change",
] as const;

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ✅ ${label}`);
  } else {
    failures++;
    console.error(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function read(rel: string): string {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) {
    failures++;
    console.error(`  ❌ missing file: ${rel}`);
    return "";
  }
  return fs.readFileSync(p, "utf8");
}

console.log(`Scanning source root: ${ROOT}\n`);

// ── 1. Writer exists and registers every step ────────────────────────────────
console.log("1. enqueue-sales-mutation.ts (writer)");
const writer = read("lib/quickbooks/pipeline/enqueue-sales-mutation.ts");
for (const step of SALES_MOD_STEPS) {
  check(`SALES_MOD_STEPS registers "${step}"`, writer.includes(`"${step}"`));
}

// ── 2. writePipelineRow redirect guards against recycling ────────────────────
console.log("\n2. row-mutations.ts (redirect)");
const rowMutations = read("lib/quickbooks/pipeline/row-mutations.ts");
check(
  "append-only redirect present",
  rowMutations.includes("APPEND-ONLY REDIRECT") &&
    rowMutations.includes("enqueueSalesMutation(")
);

// ── 3. Dispatch pass claims the new steps ────────────────────────────────────
console.log("\n3. dispatch-pass.ts (claim list)");
const dispatch = read("lib/quickbooks/consolidator/dispatch-pass.ts");
for (const step of ["estimate_mod", "sales_order_mod"]) {
  check(`pending-dispatch claims '${step}'`, dispatch.includes(`'${step}'`));
}

// ── 4. resubmit-by-step routes them deterministically (no CREATE fallback) ──
console.log("\n4. resubmit-by-step.ts (deterministic MOD)");
const resubmit = read("lib/quickbooks/consolidator/resubmit-by-step.ts");
for (const step of ["estimate_mod", "sales_order_mod"]) {
  const caseIdx = resubmit.indexOf(`case "${step}"`);
  check(`case "${step}" exists`, caseIdx >= 0);
  if (caseIdx >= 0) {
    // Scan the case body up to the next `case "` label (window-free — a fixed
    // window already lied once, 2026-07-29).
    const nextCase = resubmit.indexOf(`case "`, caseIdx + 10);
    const body = resubmit.slice(caseIdx, nextCase < 0 ? undefined : nextCase);
    const createFallbacks = ["handleDraftOrderCreated", "handleOrderPlaced"];
    check(
      `case "${step}" never falls back to CREATE`,
      !createFallbacks.some((fn) => body.includes(fn)),
      "a mod that turns into an ADD mints a duplicate QB document"
    );
    check(
      `case "${step}" passes pipelineRowId (row-id threading)`,
      body.includes("pipelineRowId")
    );
  }
}

// ── 5. Recovery treats them as idempotent redispatch ─────────────────────────
console.log("\n5. recovery-pass.ts (orphaned-processing recovery)");
const recovery = read("lib/quickbooks/consolidator/recovery-pass.ts");
for (const step of ["estimate_mod", "sales_order_mod"]) {
  check(`IDEMPOTENT_REDISPATCH_STEPS includes "${step}"`, recovery.includes(`"${step}"`));
}

// ── 6. EditSequence heal knows the new steps ─────────────────────────────────
console.log("\n6. refresh-edit-sequence.ts (3200/3210 heal)");
const heal = read("lib/quickbooks/consolidator/refresh-edit-sequence.ts");
for (const step of ["estimate_mod", "sales_order_mod"]) {
  check(`STEP_FETCH_SPEC has ${step}`, heal.includes(`${step}:`));
}

// ── 7. Void quiescence counts them as document mutations ─────────────────────
console.log("\n7. document-quiescence.ts (void blockers)");
const quiescence = read("lib/quickbooks/pipeline/document-quiescence.ts");
check(
  "void_estimate blocks on estimate_mod",
  /void_estimate:\s*\[[^\]]*"estimate_mod"/.test(quiescence)
);
check(
  "void_sales_order blocks on sales_order_mod",
  /void_sales_order:\s*\[[^\]]*"sales_order_mod"/.test(quiescence)
);

// ── 8. Handlers thread row ids (no (doc,step) bookkeeping left) ─────────────
console.log("\n8. handlers (row-id threading)");
for (const rel of [
  "lib/quickbooks/handlers/handle-draft-order-updated.ts",
  "lib/quickbooks/handlers/handle-order-updated.ts",
]) {
  const src = read(rel);
  const name = path.basename(rel);
  check(
    `${name} uses enqueueSalesMutation + submitPipelineRowById`,
    src.includes("enqueueSalesMutation(") &&
      src.includes("submitPipelineRowById(")
  );
  check(
    `${name} no longer recycles via writePipelineRow`,
    !src.includes("writePipelineRow(")
  );
}

// ── 9. UI labels cover every step ────────────────────────────────────────────
console.log("\n9. PipelineTable.tsx (labels)");
const ui = read("admin/routes/qb-sync/components/PipelineTable.tsx");
for (const step of SALES_MOD_STEPS) {
  check(`STEP_LABELS has ${step}`, new RegExp(`${step}:\\s*"`).test(ui));
}

// ── Result ───────────────────────────────────────────────────────────────────
console.log(
  failures === 0
    ? "\n✅ append-only sales lane fully registered"
    : `\n❌ ${failures} check(s) failed`
);
process.exit(failures === 0 ? 0 : 1);
