/**
 * verify-qb-first-audit — static gate for the 09/16/2026 audit
 * (`docs/QB_FIRST_AUDIT_2026-09-16.md`): QuickBooks is the mirror, the POS is
 * the operator. Two things must stay true:
 *
 *  §1 Nobody NEW decides "paid" from `qb_is_paid` / `qb_balance_remaining_cents`
 *     (the mirror the retired hourly BillQuery monitor used to refresh). The
 *     readers that legitimately remain are listed by name — a file outside the
 *     allowlist that mentions either column fails the gate.
 *  §2 The retired jobs stay retired: no `qb-vendor-bill-payment-monitor` /
 *     `…-check-purge` job, no `vendor_bill_payment_check` producer in src/jobs.
 *  §3 The ledger tab scope names every ledger step the feed emits (the two
 *     lists are maintained by hand in different files).
 *
 * Runs on the source tree (no DB). Exit 1 on any finding.
 *   node --import ./node_modules/tsx/dist/loader.mjs src/scripts/verify/verify-qb-first-audit.ts
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { LEDGER_PIPELINE_STEPS } from "../../lib/quickbooks/pipeline/sales-pipeline-scope";
import { LEDGER_FEED_STEPS } from "../../api/admin/purchase-orders/qb-pipeline/_lib/feed-sql";

const ROOT = join(__dirname, "../../..");
const SRC = join(ROOT, "src");
const POS = join(ROOT, "..", "store-pos");

/** Files allowed to mention the mirror columns, and why. */
const ALLOWED_MIRROR_READERS = new Set<string>([
  // writers of the mirror at BillAdd/Mod confirm (QuickBooks' own value)
  "src/lib/quickbooks/consolidator/poll-submitted-rows.ts",
  "src/lib/quickbooks/consolidator/vendor-bill-rebuild-operations.ts",
  // schema / migrations / DTO passthrough (no decision taken on the value)
  "src/modules/purchase-orders/models/vendor-bill.ts",
  "src/modules/purchase-orders/migrations/Migration20260724223000.ts",
  "src/modules/purchase-orders/migrations/Migration20260730040000.ts",
  "src/migrations/1782300000000-CreateQbReverseVoidFinding.ts",
  "src/api/admin/vendor-bills/route.ts",
  "src/api/admin/vendor-bills/[id]/route.ts",
  "src/api/admin/quickbooks/pipeline/handlers/get-pipeline.ts",
  "src/api/admin/accounting/payables/route.ts",
  "src/lib/banking/movement-source.ts",
  "src/lib/qb-backfill/create-bill.ts",
  "src/lib/finance/recompute-bill-finance.ts",
  // manual, on-demand "is this bill still in QuickBooks?" escape hatch
  "src/api/admin/vendor-bills/[id]/check-payment/route.ts",
  "src/lib/quickbooks/pipeline/vendor-bill-missing.ts",
  "src/jobs/qb-pipeline-error-digest.ts",
  // ap-rounding-cleanup-20260916: reconciles QuickBooks-paid bills' residuals — QB-based by design
  "src/api/admin/accounting/payables/write-off-rounding/route.ts",
  "src/api/admin/purchase-orders/qb-pipeline/[id]/mark-fixed/route.ts",
  // this gate
  "src/scripts/verify/verify-qb-first-audit.ts",
]);
const ALLOWED_POS_READERS = new Set<string>([
  "lib/types/purchase-orders.ts", // DTO type only
  "lib/bill-payments/api.ts", // DTO type only
  "app/(pos)/accounting/pay-bills/page.tsx", // "QB paid" informational counter (pay-bills v2)
  "app/(pos)/accounting/pay-bills/_lib/pay-bills-state.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "__tests__" || name.endsWith(".spec.ts")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const findings: string[] = [];
const MIRROR = /\bqb_is_paid\b|\bqb_balance_remaining_cents\b/;
/** Code only: a comment that explains why the mirror is NOT used must not trip the gate. */
const mentionsMirrorInCode = (file: string): boolean =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .some((line) => MIRROR.test(line));

// §1 backend
for (const file of walk(SRC)) {
  if (file.includes(`${join(SRC, "scripts")}`) && !file.endsWith("verify-qb-first-audit.ts")) continue;
  const rel = relative(ROOT, file);
  if (!mentionsMirrorInCode(file)) continue;
  if (!ALLOWED_MIRROR_READERS.has(rel)) findings.push(`§1 new reader of the QuickBooks paid mirror: ${rel}`);
}
// §1 POS
if (existsSync(POS)) {
  for (const dir of ["app", "lib", "components"]) {
    const base = join(POS, dir);
    if (!existsSync(base)) continue;
    for (const file of walk(base)) {
      const rel = relative(POS, file);
      if (!mentionsMirrorInCode(file)) continue;
      if (!ALLOWED_POS_READERS.has(rel)) findings.push(`§1 new POS reader of qb_is_paid: store-pos/${rel}`);
    }
  }
}
// §2 retired jobs
for (const name of ["qb-vendor-bill-payment-monitor.ts", "qb-vendor-bill-payment-check-purge.ts"]) {
  if (existsSync(join(SRC, "jobs", name))) findings.push(`§2 retired job is back: src/jobs/${name}`);
}
for (const file of walk(join(SRC, "jobs"))) {
  if (/vendor_bill_payment_check/.test(readFileSync(file, "utf8"))) findings.push(`§2 a job produces vendor_bill_payment_check rows: ${relative(ROOT, file)}`);
}
// §3 ledger scope parity: every raw step has its feed step and vice versa
const rawToFeed: Record<string, string[]> = {
  gl_document_add: ["add_gl_document"],
  gl_document_void: ["void_gl_document"],
  bill_payment_add: ["add_bill_payment"],
  bill_payment_void: ["void_bill_payment"],
  vendor_credit_apply: ["apply_vendor_credit"],
  qb_import_void: ["void_qb_import"],
};
for (const raw of LEDGER_PIPELINE_STEPS) {
  for (const feed of rawToFeed[raw] ?? []) {
    if (!(LEDGER_FEED_STEPS as readonly string[]).includes(feed)) findings.push(`§3 LEDGER_FEED_STEPS lacks ${feed} (for ${raw})`);
  }
  if (!rawToFeed[raw]) findings.push(`§3 LEDGER_PIPELINE_STEPS has ${raw} with no feed mapping in this gate`);
}
for (const feed of LEDGER_FEED_STEPS) {
  if (!Object.values(rawToFeed).flat().includes(feed)) findings.push(`§3 LEDGER_FEED_STEPS has ${feed} with no raw step`);
}

if (findings.length) {
  console.error(`verify-qb-first-audit: ${findings.length} finding(s)`);
  for (const f of findings) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`verify-qb-first-audit: OK — §1 mirror readers allowlisted, §2 monitor retired, §3 ledger scope (${LEDGER_PIPELINE_STEPS.length} steps) in parity`);
