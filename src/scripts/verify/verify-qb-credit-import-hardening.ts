/**
 * Static contract verifier for the QB-credit import hardening. This catches
 * regressions without requiring a live QB bridge.
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const root = resolve(__dirname, "../..");
const importRoute = readFileSync(
  resolve(root, "api/admin/quickbooks/customer-credits/import/route.ts"),
  "utf8"
);
const poller = readFileSync(
  resolve(root, "lib/quickbooks/consolidator/poll-submitted-rows.ts"),
  "utf8"
);

const checks: Array<[string, boolean]> = [
  [
    "imports serialize by QB TxnID",
    importRoute.includes("pg_advisory_lock(hashtext($1))"),
  ],
  [
    "new imports consume the canonical payment sequence",
    importRoute.includes("nextval('custom_payment_seq')"),
  ],
  [
    "exact TxnID dedup ignores retired rows",
    importRoute.includes("metadata->>'qb_txn_id' = $1") &&
      importRoute.includes("deleted_at IS NULL"),
  ],
  [
    "credit memo dedup resolves through confirmed pipeline",
    importRoute.includes("JOIN pos_credit_memo cm") &&
      importRoute.includes("q.qb_txn_id = $1") &&
      importRoute.includes("repaired_stale_qb_link"),
  ],
  [
    "poller replaces stale credit-memo TxnID",
    poller.includes("(metadata->>'qb_txn_id') IS DISTINCT FROM $4") &&
      !poller.includes("AND (metadata->>'qb_txn_id') IS NULL"),
  ],
  [
    "poller keeps qb mirror aligned",
    poller.includes("qb = COALESCE(qb, '{}') || $3::jsonb"),
  ],
];

let failed = false;
for (const [label, passed] of checks) {
  console.log(`${passed ? "✓" : "✗"} ${label}`);
  failed ||= !passed;
}

if (failed) process.exitCode = 1;
