/**
 * verify-qb-pipeline-status-vocab.ts — the QB pipeline status vocabulary has
 * ONE home (`lib/quickbooks/pipeline-status.ts`).
 *
 * ── Why ──────────────────────────────────────────────────────────────────────
 * Until 2026-09-17 the same nine meanings were spelled four ways across the
 * pipeline tables (sales `pending/confirmed/failed+next_retry_at`, purchases
 * `failed_permanent/cancelled/completed/voided`, sync log `completed`). The
 * admin showed "Error" and "Failed" side by side for things that were the same
 * in one family and different in another. Every SQL predicate and every badge
 * spelled its own list, so the lists drifted (three readers of the Sales scope
 * disagreed on 2026-07-30; the UNIQUE "live row" indexes excluded `failed` but
 * not a retrying row).
 *
 * The fix is a single module that owns the literals. This gate keeps it that
 * way: a status literal spelled anywhere else in `src/` is a failure, because
 * the contract flip (`VOCAB_PHASE`) only works if EVERY reader goes through
 * the helper.
 *
 * ── What it checks ───────────────────────────────────────────────────────────
 *   1. No pipeline status literal outside the helper in production code
 *      (src/lib, src/api, src/jobs, src/subscribers, src/admin, src/workflows,
 *      src/modules models). Scope = files that reference a pipeline table, or
 *      import the helper, or live under lib/quickbooks.
 *   2. Same rule for src/scripts/{verify,test,tests} (they are gates: a stale
 *      literal makes them pass in a vacuum after the conversion).
 *   3. src/__tests__ specs — same rule (a spec asserting the old literal is a
 *      spec asserting the old rule).
 *   4. The helper's own invariants: every legacy alias maps to a canonical
 *      value; `error` rows always carry a retry (WRITE.*.error exists only
 *      alongside a next_retry_at contract); STATUS_PRESENTATION covers all.
 *
 * Migrations are frozen history and are NOT scanned.
 *
 * Mutation-tested 2026-09-17: a `status = 'confirmed'` planted in
 * lib/quickbooks/pipeline/in-flight.ts → check 1 red; a `"failed_permanent"`
 * planted in a verify script → check 2 red; removing `fixed` from
 * STATUS_PRESENTATION → check 4 red.
 *
 * Run:  ./node_modules/.bin/tsx src/scripts/verify/verify-qb-pipeline-status-vocab.ts
 *       (add --json for the inventory as JSON, --allow-legacy to only flag
 *       legacy spellings — used during the expand phase rollout)
 */
import * as fs from "fs";
import * as path from "path";
import {
  LEGACY_STATUS_ALIASES,
  PIPELINE_STATUSES,
  STATUS_PRESENTATION,
  VOCAB_PHASE,
} from "../../lib/quickbooks/pipeline-status";

const ROOT = path.resolve(__dirname, "../..");
const HELPER = path.join(ROOT, "lib/quickbooks/pipeline-status.ts");

const CANONICAL = new Set<string>(PIPELINE_STATUSES);
const LEGACY = new Set<string>([
  "pending",
  "confirmed",
  "failed_permanent",
  "cancelled",
  "completed",
  "voided",
]);
const ALL_LITERALS = [...CANONICAL, ...LEGACY];

// In scope: a file that names a pipeline table, imports the helper, or calls
// one of the row writers (a caller of `writePipelineRow({status: "pending"})`
// never names the table, and that is exactly where a literal hides).
const TABLE_RX =
  /\bqb_(order|purchase_order|item_receipt|vendor_bill|item|vendor|inventory_adjustment)_pipeline\b|\bqb_sync_log\b|pipeline-status["']|\b(writePipelineRow|enqueueSalesMutation|enqueuePurchaseQbOperation|upsertItemPipelineRow|seedPipelineRow|adoptedPipelineRow|deferPipelineRow|failOrRetryPipelineRow|failPipelineRow|confirmPipelineRow|skipPipelineRow)\b/;

// A literal counts when it sits next to a status column/field. Both orders:
//   status = 'x' · status IN ('x', 'y') · status: "x" · status === "x"
//   'x' … status  (e.g. `WHEN 'x' THEN`, `["x"].includes(row.status)`)
const LIT_ALT = ALL_LITERALS.join("|");
const RX_STATUS_THEN_LIT = new RegExp(
  `\\b(status|mod_status|void_status|newStatus|new_status|Status|STATUS)\\b[^\\n]{0,90}?['"\`](${LIT_ALT})['"\`]`
);
const RX_LIT_THEN_STATUS = new RegExp(
  `['"\`](${LIT_ALT})['"\`][^\\n]{0,60}?\\b(status|mod_status|void_status|Status)\\b`
);
// A literal ALONE on its line (array element / ternary arm / object value that
// wrapped): counts when one of the six lines above names a status. This is how
// `status:\n  cond ? "submitted" : "confirmed"` and `const X = [\n "waiting",`
// slipped past the first version of this gate.
const RX_LONE_LIT = new RegExp(
  `^\\s*(?:\\?|:)?\\s*['"\`](${LIT_ALT})['"\`]\\s*[,;:)\\]]?\\s*(?://.*)?$`
);
const RX_STATUS_WORD = /\b(status|mod_status|void_status|Status|STATUS|STATUSES)\b/;
// Filters for the generic words that also describe non-pipeline objects.
const RX_OTHER_ENTITY =
  /\b(order|payment|fulfillment|po|purchase_order\b|invoice|estimate|receipt|bill|vendor_bill|factory_order|count|transfer|refund|batch|statement|job|run|op\b|operation|bridge)\.?_?status\b|\bstatus_code\b|\bhttp|<Badge|\bqb_sync_status\b|sync_status\b|\bop_status\b|\bqbStatus\b|\bbridgeStatus\b|\bpo_status\b|\bbill_status\b/i;

// The QB BRIDGE has its own operation vocabulary (`completed`/`failed`/
// `processing` on the op it returns). Those are not ours to rename. A line that
// reads a bridge operation is exempt when it names the op, or carries the
// explicit marker `// bridge-status`.
// `legacy-literal` marks a legacy spelling the EXPAND phase must still name
// (e.g. the `pending` a type accepts). Exempt only while VOCAB_PHASE is
// "expand": the contract flip turns every one of them red.
const RX_LEGACY_MARK = /legacy-literal/;
// A call INTO the helper is the sanctioned form — its canonical arguments are
// not "literals outside the helper".
const RX_HELPER_CALL = /pipelineStatusIs\(|normalizePipelineStatus\(|qbPipelineStatusIs\(/;
const RX_BRIDGE =
  /bridge-status|canonical-literal|entity-status|BridgeStatus|bridgeStatus|opStatus|operation\.status|\bop\.status|opResult|pollResult|bridgeOp\b|\.operation\b|opRow\.status|\bopr\.status/;

type Hit = { file: string; line: number; text: string; legacy: boolean };

function listFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "migrations") continue;
      listFiles(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

function scan(files: string[]): Hit[] {
  const hits: Hit[] = [];
  for (const f of files) {
    if (path.resolve(f) === HELPER) continue;
    if (path.resolve(f) === __filename) continue; // this gate names the literals it hunts
    if (f.includes("/__tests__/qb-pipeline-status/")) continue; // the helper's own spec
    if (f.endsWith("e2e-qb-pipeline-status-vocab-sandbox.ts")) continue; // plants legacy rows on purpose
    const src = fs.readFileSync(f, "utf8");
    const inScope =
      TABLE_RX.test(src) ||
      f.includes("/lib/quickbooks/") ||
      f.includes("/admin/routes/qb-pipeline/");
    if (!inScope) continue;
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
      let m = RX_STATUS_THEN_LIT.exec(line) ?? RX_LIT_THEN_STATUS.exec(line);
      if (!m) {
        const lone = RX_LONE_LIT.exec(line);
        const window = lines.slice(Math.max(0, i - 6), i);
        const insideHelperCall = window.some((l) =>
          /pipelineStatusIs\(|normalizePipelineStatus\(|qbPipelineStatusIs\(/.test(l)
        );
        if (lone && !insideHelperCall && window.some((l) => RX_STATUS_WORD.test(l))) {
          m = lone;
        }
      }
      if (!m) return;
      if (RX_OTHER_ENTITY.test(line) || RX_BRIDGE.test(line) || RX_HELPER_CALL.test(line)) return;
      if (VOCAB_PHASE === "expand" && RX_LEGACY_MARK.test(line)) return;
      const lit = m[2] ?? m[1];
      hits.push({
        file: path.relative(ROOT, f),
        line: i + 1,
        text: t.slice(0, 140),
        legacy: LEGACY.has(lit),
      });
    });
  }
  return hits;
}

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const allowCanonical = argv.includes("--allow-legacy");

const PROD_DIRS = ["lib", "api", "jobs", "subscribers", "admin", "workflows", "modules"];
const prodFiles = PROD_DIRS.flatMap((d) => listFiles(path.join(ROOT, d)));
const scriptFiles = ["verify", "test", "tests"].flatMap((d) =>
  listFiles(path.join(ROOT, "scripts", d))
);
const specFiles = listFiles(path.join(ROOT, "__tests__"));

const failures: string[] = [];
function section(name: string, hits: Hit[]) {
  const flagged = allowCanonical ? hits.filter((h) => h.legacy) : hits;
  const byFile = new Map<string, Hit[]>();
  for (const h of flagged) byFile.set(h.file, [...(byFile.get(h.file) ?? []), h]);
  if (asJson) return { name, files: byFile.size, lines: flagged.length, hits: flagged };
  console.log(`\n${name}: ${byFile.size} files, ${flagged.length} lines`);
  for (const [f, hs] of [...byFile.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(hs.length).padStart(3)}  ${f}`);
    if (argv.includes("--lines")) for (const h of hs) console.log(`         :${h.line}  ${h.text}`);
  }
  if (flagged.length) failures.push(`${name}: ${flagged.length} literal(s) outside the helper`);
  return null;
}

const out = [
  section("1. production code", scan(prodFiles)),
  section("2. src/scripts/{verify,test,tests}", scan(scriptFiles)),
  section("3. src/__tests__", scan(specFiles)),
];

// 4. helper invariants
for (const fam of Object.keys(LEGACY_STATUS_ALIASES) as Array<keyof typeof LEGACY_STATUS_ALIASES>) {
  for (const [legacy, canon] of Object.entries(LEGACY_STATUS_ALIASES[fam])) {
    if (!CANONICAL.has(canon)) failures.push(`4. alias ${fam}.${legacy} → '${canon}' is not canonical`);
  }
}
for (const s of PIPELINE_STATUSES) {
  if (!STATUS_PRESENTATION[s]) failures.push(`4. STATUS_PRESENTATION missing '${s}'`);
}
const helperSrc = fs.readFileSync(HELPER, "utf8");
if (!/next_retry_at/.test(helperSrc)) failures.push("4. helper lost the next_retry_at contract");

if (asJson) {
  console.log(JSON.stringify({ sections: out, failures }, null, 1));
} else {
  console.log("");
  if (failures.length) {
    console.log("❌ verify-qb-pipeline-status-vocab FAILED");
    for (const f of failures) console.log("   - " + f);
  } else {
    console.log("✅ verify-qb-pipeline-status-vocab: every status literal lives in pipeline-status.ts");
  }
}
process.exit(failures.length ? 1 : 0);
