/**
 * Gate for the reverse void audit (alive in POS, voided/deleted in QB).
 *
 * Run with:  ./node_modules/.bin/tsx src/scripts/verify/verify-reverse-void-audit.ts
 * (plain tsx script — needs no container and no database)
 *
 * Checks two kinds of things:
 *  A. Structural invariants that no other gate sees (the JobLoader guard, the
 *     digest wiring, the QBXML query shape probed live on 2026-08-07, and the
 *     upsert's constraint name matching the migration).
 *  B. Behavioral smoke of the comparator via real imports — flag and no-flag
 *     branches, so a broken comparator cannot pass on structure alone.
 *
 * Mutation-tested at birth: each check was verified to FAIL against a broken
 * copy before being trusted (guard removed, section unplugged, constraint
 * renamed).
 */
import { readFileSync } from "fs";
import { resolve } from "path";

import {
  buildTxnDeletedQueryQbxml,
  buildZeroScanQbxml,
  compareScanToCandidates,
} from "../../lib/quickbooks/reverse-void-sweep";

const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

console.log("A. Structural invariants");

const job = read("src/jobs/qb-reverse-void-monitor.ts");
const guardIdx = job.indexOf("isScheduledJobsDisabled(container)");
const bodyIdx = job.indexOf("runReverseVoidSweep(");
check(
  "job guards isScheduledJobsDisabled BEFORE doing any work",
  guardIdx > 0 && bodyIdx > 0 && guardIdx < bodyIdx,
  "a dev zombie would sweep prod QB without it"
);
check(
  "job exports a cron config",
  /export const config[\s\S]*schedule:/.test(job)
);

const digest = read("src/jobs/qb-pipeline-error-digest.ts");
const pushIdx = digest.indexOf("collectReverseVoidSection(");
const reduceIdx = digest.indexOf("sections.reduce");
check(
  "digest collects the reverse-void section BEFORE counting qbErrors",
  pushIdx > 0 && reduceIdx > 0 && pushIdx < reduceIdx,
  "a section pushed after the reduce is invisible in the subject count"
);

const migration = read(
  "src/migrations/1782300000000-CreateQbReverseVoidFinding.ts"
);
const sweepSrc = read("src/lib/quickbooks/reverse-void-sweep.ts");
const CONSTRAINT = "UQ_qb_reverse_void_finding_txn_kind";
check(
  "upsert constraint name matches the migration",
  migration.includes(CONSTRAINT) && sweepSrc.includes(CONSTRAINT),
  "a renamed constraint breaks persistFindings only at runtime"
);

console.log("B. Query shape (probed live 2026-08-07)");

const delQ = buildTxnDeletedQueryQbxml("2026-08-01", "2026-08-07");
for (const t of ["Invoice", "SalesReceipt", "CreditMemo", "ReceivePayment"]) {
  check(`TxnDeletedQuery covers ${t}`, delQ.includes(`<TxnDelType>${t}</TxnDelType>`));
}
check(
  "TxnDeletedQuery carries the full QBXML envelope (raw passthrough adds none)",
  delQ.startsWith('<?xml version="1.0"') && delQ.includes("<QBXMLMsgsRq")
);

const scanQ = buildZeroScanQbxml("Invoice", "2026-08-01", "2026-08-07");
check("zero scan filters by ModifiedDateRangeFilter", scanQ.includes("ModifiedDateRangeFilter"));
check(
  "zero scan is header-only (no IncludeLineItems) and never uses iterators",
  !scanQ.includes("IncludeLineItems") && !scanQ.includes("iterator")
);

console.log("C. Comparator behavior (real imports)");

const cand = {
  entity: "pos_invoice" as const,
  reference_id: "x",
  order_id: null,
  medusa_ref: "20215",
  qb_txn_id: "T-1",
  qb_ref_number: null,
  pos_total_cents: 1000,
};
const flagged = compareScanToCandidates({
  candidates: new Map([["T-1", cand]]),
  deleted: [{ qb_txn_id: "T-1", qb_del_type: "Invoice", time_deleted: null }],
  zeroDocs: [],
});
check("comparator flags a deleted, referenced doc", flagged.length === 1);

const notFlagged = compareScanToCandidates({
  candidates: new Map([["T-1", { ...cand, pos_total_cents: 0 }]]),
  deleted: [],
  zeroDocs: [
    {
      qb_txn_id: "T-1",
      qb_ref_number: null,
      memo: null,
      time_modified: null,
      scan_type: "Invoice",
    },
  ],
});
check("comparator never flags an honestly-$0 POS doc as voided", notFlagged.length === 0);

if (failures > 0) {
  console.error(`\nFAILED — ${failures} check(s) down`);
  process.exit(1);
}
console.log("\nOK — reverse void audit invariants hold");
