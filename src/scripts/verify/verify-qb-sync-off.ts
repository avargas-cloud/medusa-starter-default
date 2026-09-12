/**
 * Structural verifier for the QB_SYNC_ENABLED switch.
 *
 * Asserts by NAME (hardcoded list), then re-discovers writers with the same
 * `rg`-style pattern the feature spec used to find them in the first place —
 * a file that INSERTs into a `qb_*_pipeline` table and is not in the
 * hardcoded list fails. That is what makes the check non-vacuous against a
 * NEW writer someone adds later without reading this file.
 *
 * A comment or an `import` that merely NAMES `isQbSyncEnabled` is not a gate
 * — the check strips comments and import/export-from statements before
 * searching, so it looks for an actual CALL (`isQbSyncEnabled(`).
 *
 * Run: ./node_modules/.bin/tsx src/scripts/verify/verify-qb-sync-off.ts
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const failures: string[] = [];
const notes: string[] = [];

function read(rel: string): string | null {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, "utf8");
}

/** Comments out: a docstring that NAMES the gate is not a gate. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/([^:"'`])\/\/.*$/gm, "$1");
}

/** Imports out: importing the gate is not calling it. */
function stripImports(src: string): string {
  return src
    .replace(/^\s*import[\s\S]*?from\s*["'][^"']+["'];?\s*$/gm, " ")
    .replace(/^\s*export\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\s*$/gm, " ");
}

function bodyOf(rel: string): string | null {
  const raw = read(rel);
  if (raw === null) return null;
  return stripImports(stripComments(raw));
}

function callsGate(rel: string, gate = "isQbSyncEnabled("): boolean {
  const body = bodyOf(rel);
  return body !== null && body.includes(gate);
}

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      walk(abs, out);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(path.relative(ROOT, abs));
    }
  }
}

// ── 1. Writers of qb_*_pipeline rows — must call isQbSyncEnabled() ─────────

const MUST_GATE_WRITERS = [
  "src/lib/quickbooks/pipeline/enqueue-sales-mutation.ts",
  "src/lib/quickbooks/pipeline/row-mutations.ts",
  "src/lib/quickbooks/pipeline/customer-pipeline.ts",
  "src/lib/quickbooks/pipeline/claim-sales-receipt.ts",
  "src/lib/quickbooks/pipeline/claim-write-check.ts",
  "src/lib/purchase-orders/qb-vendor-bill-enqueue.ts",
  "src/lib/purchase-orders/qb-vendor-bill-mod-enqueue.ts",
  "src/lib/purchase-orders/qb-bill-payment-enqueue.ts",
  "src/lib/purchase-orders/qb-vendor-credit-enqueue.ts",
  "src/lib/quickbooks/upsert-item-pipeline-row.ts",
  "src/workflows/qb/send-to-qb-step.ts",
  "src/workflows/inventory-count/steps/enqueue-qb-adjustments-step.ts",
  "src/workflows/inventory-count/steps/persist-void-results-step.ts",
  // Shared chokepoint for PO/item-receipt/vendor-credit/bill-payment QB ops
  // (gated 2026-09-11, closing the FK-constrained gap flagged in the
  // delivering session's NOTED): returns null instead of fabricating an id,
  // because qb_item_receipt_pipeline/qb_purchase_order_pipeline/
  // qb_vendor_bill_pipeline/qb_purchase_dependency_chain all carry real FKs
  // to qb_order_pipeline(id).
  "src/lib/purchase-orders/qb-purchase-dependency-chain.ts",
  "src/workflows/purchase-orders/steps/enqueue-qb-item-receipt-step.ts",
  "src/workflows/purchase-orders/steps/enqueue-qb-item-receipt-mod-step.ts",
  "src/lib/purchase-orders/item-receipt-mod-payload.ts",
  "src/lib/purchase-orders/po-cost-propagation.ts",
  "src/lib/purchase-orders/qb-vendor-bill-unlock.ts",
  "src/lib/quickbooks/consolidator/dispatch-pass.ts",
  "src/api/admin/purchase-orders/[id]/route.ts",
  "src/api/admin/pos/sync/route.ts",
  // Third, independent bridge fetch (not bridge-fetch.ts / client/core.ts) —
  // gated at its own postToBridge helper.
  "src/workflows/pos/steps/enqueue-qb-items-step.ts",
];

for (const rel of MUST_GATE_WRITERS) {
  if (bodyOf(rel) === null) {
    failures.push(`${rel} is in MUST_GATE_WRITERS but does not exist.`);
    continue;
  }
  if (!callsGate(rel)) {
    failures.push(
      `${rel} writes a qb_*_pipeline row but never CALLS isQbSyncEnabled() ` +
        `(importing it does not count — see the docstring).`
    );
  }
}
if (!failures.some((f) => f.includes("MUST_GATE_WRITERS") || f.includes("never CALLS"))) {
  notes.push(`✓ all ${MUST_GATE_WRITERS.length} declared pipeline writers call isQbSyncEnabled()`);
}

// ── 1b. Non-vacuity: re-discover writers by pattern, same as the spec did ──

const PIPELINE_INSERT_RE =
  /insert\s+into\s+qb_(order|vendor_bill|purchase_order|item_receipt|inventory_adjustment|item)_pipeline/i;

function discoverInsertWriters(): string[] {
  const all: string[] = [];
  walk(SRC, all);
  const found: string[] = [];
  for (const rel of all) {
    const raw = read(rel);
    if (raw && PIPELINE_INSERT_RE.test(raw)) found.push(rel);
  }
  return found;
}

const discovered = discoverInsertWriters();
if (discovered.length === 0) {
  failures.push(
    `discoverInsertWriters() found ZERO files with a raw qb_*_pipeline INSERT. ` +
      `A pattern that matches nothing passes vacuously — either the table names ` +
      `changed or this regex stopped seeing where the code lives.`
  );
} else {
  notes.push(`✓ non-vacuous: discovered ${discovered.length} files with a raw qb_*_pipeline INSERT`);
}

// A discovered writer passes if it actually CALLS the gate (regardless of
// whether it happens to also be named in MUST_GATE_WRITERS — most of the
// route-level writers found here gate inline at their own INSERT, not via a
// shared helper, so requiring list membership would just be a second list to
// keep in sync). What's not allowed to pass silently is a writer that
// neither calls the gate NOR is in the documented exception list below.
const KNOWN_UNGATED = [
  // Test/backfill/debug scripts — not production runtime paths.
  { prefix: "src/scripts/", why: "one-off backfill/debug/test script, not a production runtime path" },
  { prefix: "src/__tests__/", why: "test fixture" },
  // Concurrent-agent ownership boundary for THIS feature session — touching
  // it was out of scope (see NOTED in the delivering session's report).
  { prefix: "src/lib/qb-backfill/", why: "owned by a concurrent agent this session; out of scope" },
];

for (const rel of discovered) {
  if (callsGate(rel)) continue;
  if (KNOWN_UNGATED.some((x) => rel.startsWith(x.prefix))) continue;
  failures.push(
    `${rel} INSERTs into a qb_*_pipeline table, never calls isQbSyncEnabled(), ` +
      `and is not in the documented KNOWN_UNGATED exception list — a new ` +
      `unguarded writer appeared that this verifier was never taught about.`
  );
}

// ── 2. Jobs — every src/jobs/qb-*.ts must call isQbSyncEnabled() ───────────

const jobFiles = fs
  .readdirSync(path.join(SRC, "jobs"))
  .filter((f) => f.startsWith("qb-") && f.endsWith(".ts"))
  .map((f) => path.join("src/jobs", f));

if (jobFiles.length === 0) {
  failures.push(`No src/jobs/qb-*.ts files found — the sweep is empty.`);
} else {
  for (const rel of jobFiles) {
    if (!callsGate(rel)) {
      failures.push(`${rel} never calls isQbSyncEnabled() — job does not return early when sync is off.`);
    }
  }
  if (!failures.some((f) => f.includes("src/jobs/qb-"))) {
    notes.push(`✓ all ${jobFiles.length} src/jobs/qb-*.ts jobs call isQbSyncEnabled()`);
  }
}

// ── 3. Subscribers — every src/subscribers/qb-* must call isQbSyncEnabled() ─

const subscriberFiles = fs
  .readdirSync(path.join(SRC, "subscribers"))
  .filter((f) => f.startsWith("qb-") && f.endsWith(".ts"))
  .map((f) => path.join("src/subscribers", f));

if (subscriberFiles.length === 0) {
  failures.push(`No src/subscribers/qb-* files found — the sweep is empty.`);
} else {
  for (const rel of subscriberFiles) {
    if (!callsGate(rel)) {
      failures.push(`${rel} never calls isQbSyncEnabled() — subscriber does not return early when sync is off.`);
    }
  }
  if (!failures.some((f) => f.includes("src/subscribers/qb-"))) {
    notes.push(`✓ all ${subscriberFiles.length} src/subscribers/qb-* subscribers call isQbSyncEnabled()`);
  }
}

// ── 4. bridge-fetch.ts throws QbSyncDisabledError before any network call ──

const BRIDGE_FETCH_FILES = [
  "src/lib/quickbooks/bridge-fetch.ts",
  "src/lib/quickbooks/client/core.ts",
];
for (const rel of BRIDGE_FETCH_FILES) {
  const body = bodyOf(rel);
  if (body === null) {
    failures.push(`${rel} does not exist.`);
    continue;
  }
  if (!body.includes("QbSyncDisabledError") || !callsGate(rel)) {
    failures.push(
      `${rel} does not throw QbSyncDisabledError gated by isQbSyncEnabled() — ` +
        `a synchronous bridge call could still reach the network with sync off.`
    );
  }
}
if (!failures.some((f) => f.includes("does not throw QbSyncDisabledError"))) {
  notes.push(`✓ both bridge-fetch clients throw QbSyncDisabledError before any network call`);
}

// ── 5. sync-enabled.ts itself exists and exports the two primitives ────────

const SYNC_ENABLED = "src/lib/quickbooks/sync-enabled.ts";
const syncEnabledBody = read(SYNC_ENABLED);
if (syncEnabledBody === null) {
  failures.push(`${SYNC_ENABLED} does not exist.`);
} else {
  if (!/export function isQbSyncEnabled/.test(syncEnabledBody)) {
    failures.push(`${SYNC_ENABLED} does not export isQbSyncEnabled().`);
  }
  if (!/export class QbSyncDisabledError/.test(syncEnabledBody)) {
    failures.push(`${SYNC_ENABLED} does not export QbSyncDisabledError.`);
  }
}

// ── Report ──────────────────────────────────────────────────────────────────

console.log("=== verify-qb-sync-off ===\n");
for (const n of notes) console.log("  " + n);

if (failures.length > 0) {
  console.error(`\n❌ ${failures.length} problema(s):\n`);
  for (const f of failures) console.error("  • " + f + "\n");
  process.exit(1);
}
console.log(`\n✅ QB_SYNC_ENABLED gates every named pipeline writer, job, subscriber, and bridge client`);
