/**
 * verify-customer-documents-routes.ts — static assertions for the 3
 * customer-scoped storefront document routes (invoices list/detail,
 * shipments) and their shared query module:
 *
 *   (a) each route reads auth_context?.actor_id and 401s without it.
 *   (b) customer-documents.ts filters by a BOUND customer_id parameter
 *       (never a string-interpolated value).
 *   (c) customer-documents.ts's output object literals contain NONE of the
 *       forbidden field names as keys.
 *   (d) the invoice queries exclude drafts (`status <> 'draft'`).
 *
 * READ-ONLY except for the (c) mutation test, which edits a temp copy in
 * the OS tmp dir (never the real file) and diffs it back to nothing.
 *
 * exit 1 on any FAIL.
 * Run: ./node_modules/.bin/tsx src/scripts/verify/verify-customer-documents-routes.ts
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = process.cwd();
const MODULE_REL = "src/lib/storefront/customer-documents.ts";

const ROUTES = [
  "src/api/store/customers/me/invoices/route.ts",
  "src/api/store/customers/me/invoices/[id]/route.ts",
  "src/api/store/customers/me/shipments/route.ts",
];

const FORBIDDEN_FIELDS = [
  "average_unit_cost",
  "average_unit_cost_synced_at",
  "net_total_cents",
  "created_by",
  "notes",
  "metadata",
  "amount_paid",
  "balance_due",
  "payment_method",
  "card_brand",
  "provider_object_id",
  "label_url",
  "rate_amount_cents",
  "assigned_by_user_id",
  "created_by_user_id",
  "idempotency_key",
  "void_reason",
];

interface Check {
  label: string;
  pass: boolean;
  detail: string;
}

const checks: Check[] = [];

function record(label: string, pass: boolean, detail: string): void {
  checks.push({ label, pass, detail });
}

// ── (a) each route reads auth_context?.actor_id and 401s without it ────────
function checkRouteAuth(): void {
  for (const rel of ROUTES) {
    const src = readFileSync(join(ROOT, rel), "utf8");

    const readsActorId = /auth_context\?\.actor_id/.test(src);
    record(
      `${rel}: reads auth_context?.actor_id`,
      readsActorId,
      readsActorId ? "present" : "NOT FOUND"
    );

    const has401 = /status\(401\)\.json\(/.test(src);
    record(`${rel}: has a 401 response`, has401, has401 ? "present" : "NOT FOUND");

    // The 401 must be gated on the customerId check, not unconditional —
    // look for the customary shape "if (!customerId) { ... 401 ..."
    const gatedIdx = src.search(/if\s*\(\s*!customerId\s*\)\s*\{[^}]*401/s);
    record(
      `${rel}: 401 is gated on !customerId`,
      gatedIdx !== -1,
      gatedIdx !== -1 ? "present" : "NOT FOUND (401 not tied to the customerId check)"
    );
  }
}

// ── (b) customer_id filter uses a bound parameter ───────────────────────────
function checkBoundCustomerFilter(): void {
  const src = readFileSync(join(ROOT, MODULE_REL), "utf8");

  // pos_invoice / order customer_id comparisons must use `?` placeholders
  // (this repo's knex-raw idiom), never a template-interpolated value.
  const hasBoundInvoiceFilter = /i\.customer_id\s*=\s*\?/.test(src);
  const hasBoundOrderFilter = /o\.customer_id\s*=\s*\?/.test(src);
  record(
    "customer-documents.ts: i.customer_id = ? (bound)",
    hasBoundInvoiceFilter,
    hasBoundInvoiceFilter ? "present" : "NOT FOUND"
  );
  record(
    "customer-documents.ts: o.customer_id = ? (bound)",
    hasBoundOrderFilter,
    hasBoundOrderFilter ? "present" : "NOT FOUND"
  );

  // No string-interpolated customerId into SQL (the injection shape this
  // check exists to catch).
  const hasInterpolatedCustomerId = /\$\{[^}]*customerId[^}]*\}/.test(src);
  record(
    "customer-documents.ts: customerId never template-interpolated into SQL",
    !hasInterpolatedCustomerId,
    hasInterpolatedCustomerId ? "FOUND interpolation of customerId" : "clean"
  );
}

// ── (c) forbidden fields never appear as output object-literal keys ────────
function scanForbiddenFields(src: string): string[] {
  // Strip single-line comments and import/type lines before scanning —
  // a mention in a comment or an import specifier isn't an output key.
  const codeLines = src
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l.trim()))
    .filter((l) => !/^\s*import\b/.test(l.trim()));
  const code = codeLines.join("\n");

  const hits: string[] = [];
  for (const field of FORBIDDEN_FIELDS) {
    const re = new RegExp(`\\b${field}\\b\\s*:`, "g");
    if (re.test(code)) hits.push(field);
  }
  return hits;
}

function checkForbiddenFieldsAbsent(): void {
  const src = readFileSync(join(ROOT, MODULE_REL), "utf8");
  const hits = scanForbiddenFields(src);
  record(
    "customer-documents.ts: no forbidden field as an output key",
    hits.length === 0,
    hits.length === 0 ? "clean" : `FOUND: ${hits.join(", ")}`
  );
}

// Mutation test: prove the forbidden-fields check actually catches a leak.
function mutationTestForbiddenFields(): void {
  const original = readFileSync(join(ROOT, MODULE_REL), "utf8");
  const tmpDir = mkdtempSync(join(tmpdir(), "verify-customer-docs-"));
  const tmpFile = join(tmpDir, "customer-documents.mutated.ts");

  // Inject a forbidden field into the invoice projection, mirroring a real
  // leak (spreading amount_paid onto the customer-facing object).
  const mutated = original.replace(
    "refunded_amount: centsToDollarsNum(row.refunded_amount),",
    "refunded_amount: centsToDollarsNum(row.refunded_amount),\n    amount_paid: row.amount_paid,"
  );

  if (mutated === original) {
    record(
      "mutation test: injected forbidden field",
      false,
      "anchor line not found — could not inject mutation"
    );
    rmSync(tmpDir, { recursive: true, force: true });
    return;
  }

  writeFileSync(tmpFile, mutated, "utf8");
  const hits = scanForbiddenFields(readFileSync(tmpFile, "utf8"));
  const caughtIt = hits.includes("amount_paid");

  record(
    "mutation test: forbidden-fields check FAILS on a mutated copy with amount_paid",
    caughtIt,
    caughtIt
      ? `caught: ${hits.join(", ")} (in ${tmpFile}, now discarded)`
      : "mutation NOT caught — check is not effective"
  );

  rmSync(tmpDir, { recursive: true, force: true });

  // Sanity: the real, unmutated file still passes.
  const cleanHits = scanForbiddenFields(original);
  record(
    "sanity: unmutated customer-documents.ts still passes forbidden-fields check",
    cleanHits.length === 0,
    cleanHits.length === 0 ? "clean" : `FOUND: ${cleanHits.join(", ")}`
  );
}

// ── (d) draft invoices excluded ─────────────────────────────────────────────
function checkDraftsExcluded(): void {
  const src = readFileSync(join(ROOT, MODULE_REL), "utf8");
  const occurrences = src.split("status <> 'draft'").length - 1;
  record(
    "customer-documents.ts: status <> 'draft' present (list + detail)",
    occurrences >= 2,
    `found ${occurrences} occurrence(s), expected >= 2 (list query + detail query)`
  );
}

function main(): void {
  console.log("── verify-customer-documents-routes ──────────────────────────\n");

  checkRouteAuth();
  checkBoundCustomerFilter();
  checkForbiddenFieldsAbsent();
  mutationTestForbiddenFields();
  checkDraftsExcluded();

  let failures = 0;
  for (const c of checks) {
    console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.label}\n      ${c.detail}`);
    if (!c.pass) failures++;
  }

  console.log(`\n${checks.length - failures}/${checks.length} passed`);
  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED.`);
    process.exit(1);
  }
}

main();
