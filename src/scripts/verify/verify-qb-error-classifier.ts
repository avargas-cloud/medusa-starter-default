/**
 * Static verifier for the QB error classifier + retry decision logic.
 *
 * Pure: no DB, no bridge, no network. Runs in <1s.
 *
 * Usage:
 *   yarn medusa exec src/scripts/verify/verify-qb-error-classifier.ts
 *
 * Each scenario is a triple (error, expected_class, expected_isTransient).
 * The list intentionally includes real error messages we've seen in
 * production incidents so the verifier doubles as a regression suite.
 */
import type { ExecArgs } from "@medusajs/framework/types";
import {
  classifyQbError,
  type QbErrorClass,
} from "../../lib/quickbooks/error-classifier";
import { decideRetry } from "../../lib/quickbooks/retry-config";

interface ClassifyCase {
  label: string;
  input: { message?: string | null; code?: string | number | null };
  expected: QbErrorClass;
  isTransient: boolean;
  isRecoverable: boolean;
}

const CLASSIFY_CASES: ClassifyCase[] = [
  // ─── lock (3170) ──────────────────────────────────────────────────────
  {
    label: "code 3170 alone",
    input: { code: "3170" },
    expected: "lock",
    isTransient: true,
    isRecoverable: false,
  },
  {
    label: "numeric 3170",
    input: { code: 3170 },
    expected: "lock",
    isTransient: true,
    isRecoverable: false,
  },
  {
    label: "real DataExt 3170 from PO #34 incident (2026-05-01)",
    input: {
      code: "3170",
      message:
        'There was an error when modifying a data extension named "Distribution Channel". QuickBooks error message: This list has been modified by another user.',
    },
    expected: "lock",
    isTransient: true,
    isRecoverable: false,
  },
  {
    label: "modified by another user (no code)",
    input: { message: "List has been modified by another user." },
    expected: "lock",
    isTransient: true,
    isRecoverable: false,
  },

  // ─── edit_seq (3210) ──────────────────────────────────────────────────
  {
    label: "code 3210 alone",
    input: { code: "3210" },
    expected: "edit_seq",
    isTransient: true,
    isRecoverable: false,
  },
  {
    label: "EditSequence in message",
    input: { message: "The EditSequence does not match the current value." },
    expected: "edit_seq",
    isTransient: true,
    isRecoverable: false,
  },
  {
    label: "edit sequence with space",
    input: { message: "Stale edit sequence sent for invoice." },
    expected: "edit_seq",
    isTransient: true,
    isRecoverable: false,
  },

  // ─── duplicate (3200) ─────────────────────────────────────────────────
  {
    label: "code 3200 alone",
    input: { code: "3200" },
    expected: "duplicate",
    isTransient: true,
    isRecoverable: true,
  },
  {
    label: "already exists message",
    input: { message: "The name supplied already exists." },
    expected: "duplicate",
    isTransient: true,
    isRecoverable: true,
  },
  {
    label: "already in use message",
    input: { message: "Name is already in use." },
    expected: "duplicate",
    isTransient: true,
    isRecoverable: true,
  },

  // ─── not_found (3100/3120) ────────────────────────────────────────────
  {
    label: "code 3100",
    input: { code: "3100" },
    expected: "not_found",
    isTransient: true,
    isRecoverable: true,
  },
  {
    label: "code 3120",
    input: { code: "3120" },
    expected: "not_found",
    isTransient: true,
    isRecoverable: true,
  },
  {
    label: "object not found message",
    input: { message: "The object specified in the request was not found." },
    expected: "not_found",
    isTransient: true,
    isRecoverable: true,
  },
  {
    label: "no record found",
    input: { message: "No record found matching the specified criteria." },
    expected: "not_found",
    isTransient: true,
    isRecoverable: true,
  },
  {
    label: "does not exist",
    input: { message: "Item ListID 80001ABC-1234567890 does not exist." },
    expected: "not_found",
    isTransient: true,
    isRecoverable: true,
  },

  // ─── po_missing (synthetic, terminal) ─────────────────────────────────
  {
    label: "real PO-1015 synthetic message (2026-04-29 incident)",
    input: {
      message:
        "PO not found in QB (TxnID: 1C1156-1776713606) — may have been deleted",
    },
    expected: "po_missing",
    isTransient: false,
    isRecoverable: false,
  },
  {
    label: "may have been deleted alone",
    input: { message: "Record may have been deleted from QuickBooks." },
    expected: "po_missing",
    isTransient: false,
    isRecoverable: false,
  },

  // ─── parser_failed (synthetic, transient) ─────────────────────────────
  {
    label: "completed but no TxnID (PO-1015 zombie loop)",
    input: { message: "Completed but no TxnID in response" },
    expected: "parser_failed",
    isTransient: true,
    isRecoverable: false,
  },
  {
    label: "no TxnID in response",
    input: { message: "Bridge returned no TxnID in response" },
    expected: "parser_failed",
    isTransient: true,
    isRecoverable: false,
  },

  // ─── network ──────────────────────────────────────────────────────────
  {
    label: "ECONNREFUSED",
    input: { message: "fetch failed: connect ECONNREFUSED 127.0.0.1:443" },
    expected: "network",
    isTransient: true,
    isRecoverable: false,
  },
  {
    label: "ETIMEDOUT",
    input: { message: "Bridge call timed out: ETIMEDOUT" },
    expected: "network",
    isTransient: true,
    isRecoverable: false,
  },
  {
    label: "ENOTFOUND DNS",
    input: { message: "getaddrinfo ENOTFOUND qb.eptbridge.com" },
    expected: "network",
    isTransient: true,
    isRecoverable: false,
  },

  // ─── bridge_busy ──────────────────────────────────────────────────────
  {
    label: "QBWC offline",
    input: {
      message:
        "QB Desktop may be offline or QBWC not connected — bridge timed out.",
    },
    expected: "bridge_busy",
    isTransient: true,
    isRecoverable: false,
  },
  {
    label: "Web Connector queue full",
    input: { message: "Web Connector queue is full, retry shortly." },
    expected: "bridge_busy",
    isTransient: true,
    isRecoverable: false,
  },

  // ─── permanent (default) ──────────────────────────────────────────────
  {
    label: "unknown error",
    input: { message: "Something unexpected happened in QB." },
    expected: "permanent",
    isTransient: false,
    isRecoverable: false,
  },
  {
    label: "empty input",
    input: { message: "" },
    expected: "permanent",
    isTransient: false,
    isRecoverable: false,
  },
  {
    label: "null input",
    input: { message: null, code: null },
    expected: "permanent",
    isTransient: false,
    isRecoverable: false,
  },
  {
    label: "QBXML schema validation failure",
    input: { message: "QBXMLMsgsRq element is malformed: missing requestID." },
    expected: "permanent",
    isTransient: false,
    isRecoverable: false,
  },

  // ─── disambiguation: legacy regex 3[12]00 conflated these ─────────────
  {
    label: "3100 ≠ 3200 (was conflated by old regex)",
    input: { code: "3100" },
    expected: "not_found",
    isTransient: true,
    isRecoverable: true,
  },
  {
    label: "3200 ≠ 3100 (was conflated by old regex)",
    input: { code: "3200" },
    expected: "duplicate",
    isTransient: true,
    isRecoverable: true,
  },
  {
    label: "3170 ≠ 3210 (lock vs editSeq — different recovery)",
    input: { code: "3170" },
    expected: "lock",
    isTransient: true,
    isRecoverable: false,
  },
];

interface DecideCase {
  label: string;
  retriesSoFar: number;
  hasNextRetryAt: boolean;
  hasFailedPermanent: boolean;
  errorMessage: string;
  expectedStatus: "error" | "failed" | "failed_permanent";
  expectedExhausted: boolean;
  expectsBackoff: boolean;
}

const DECIDE_CASES: DecideCase[] = [
  // Phase-1 (qb_order_pipeline before migration)
  {
    label: "Phase-1: lock, retries=0 → failed (no next_retry_at yet)",
    retriesSoFar: 0,
    hasNextRetryAt: false,
    hasFailedPermanent: false,
    errorMessage: "modified by another user",
    expectedStatus: "failed",
    expectedExhausted: false,
    expectsBackoff: false,
  },
  {
    label: "Phase-1: permanent, retries=0 → failed",
    retriesSoFar: 0,
    hasNextRetryAt: false,
    hasFailedPermanent: false,
    errorMessage: "Some unknown unrecoverable error",
    expectedStatus: "failed",
    expectedExhausted: true,
    expectsBackoff: false,
  },

  // Phase-2 (qb_order_pipeline after migration / item / PO pipeline)
  {
    label: "Phase-2: lock, retries=0 → error + backoff",
    retriesSoFar: 0,
    hasNextRetryAt: true,
    hasFailedPermanent: true,
    errorMessage: "modified by another user",
    expectedStatus: "error",
    expectedExhausted: false,
    expectsBackoff: true,
  },
  {
    label: "Phase-2: lock, retries=4 (last attempt) → error + backoff (60min)",
    retriesSoFar: 4,
    hasNextRetryAt: true,
    hasFailedPermanent: true,
    errorMessage: "modified by another user",
    expectedStatus: "error",
    expectedExhausted: false,
    expectsBackoff: true,
  },
  {
    label: "Phase-2: lock, retries=5 → exhausted → failed_permanent",
    retriesSoFar: 5,
    hasNextRetryAt: true,
    hasFailedPermanent: true,
    errorMessage: "modified by another user",
    expectedStatus: "failed_permanent",
    expectedExhausted: true,
    expectsBackoff: false,
  },
  {
    label: "Phase-2: po_missing → permanent immediately (no backoff)",
    retriesSoFar: 0,
    hasNextRetryAt: true,
    hasFailedPermanent: true,
    errorMessage: "PO not found in QB (TxnID: abc) — may have been deleted",
    expectedStatus: "failed_permanent",
    expectedExhausted: true,
    expectsBackoff: false,
  },
  {
    label: "Phase-2: parser_failed → error (transient, retry helps)",
    retriesSoFar: 1,
    hasNextRetryAt: true,
    hasFailedPermanent: true,
    errorMessage: "Completed but no TxnID in response",
    expectedStatus: "error",
    expectedExhausted: false,
    expectsBackoff: true,
  },
  {
    label: "Phase-2: network → error + backoff",
    retriesSoFar: 0,
    hasNextRetryAt: true,
    hasFailedPermanent: true,
    errorMessage: "fetch failed: ETIMEDOUT",
    expectedStatus: "error",
    expectedExhausted: false,
    expectsBackoff: true,
  },
];

export default async function verifyClassifier(_args: ExecArgs) {
  const failures: string[] = [];
  let total = 0;

  console.log(`\n=== classifyQbError (${CLASSIFY_CASES.length} cases) ===`);
  for (const c of CLASSIFY_CASES) {
    total++;
    const actual = classifyQbError(c.input);
    const ok =
      actual.class === c.expected &&
      actual.isTransient === c.isTransient &&
      actual.isRecoverable === c.isRecoverable;
    if (ok) {
      console.log(`  ✓ ${c.label}`);
    } else {
      const failure = `✗ ${c.label}\n      expected: class=${c.expected} transient=${c.isTransient} recoverable=${c.isRecoverable}\n      actual:   class=${actual.class} transient=${actual.isTransient} recoverable=${actual.isRecoverable}`;
      console.log(`  ${failure}`);
      failures.push(failure);
    }
  }

  console.log(`\n=== decideRetry (${DECIDE_CASES.length} cases) ===`);
  for (const d of DECIDE_CASES) {
    total++;
    const decision = decideRetry({
      error: { message: d.errorMessage },
      retriesSoFar: d.retriesSoFar,
      hasNextRetryAt: d.hasNextRetryAt,
      hasFailedPermanent: d.hasFailedPermanent,
    });
    const hasBackoff = decision.nextRetryAt !== null;
    const ok =
      decision.newStatus === d.expectedStatus &&
      decision.exhausted === d.expectedExhausted &&
      hasBackoff === d.expectsBackoff;
    if (ok) {
      console.log(`  ✓ ${d.label}`);
    } else {
      const failure = `✗ ${d.label}\n      expected: status=${d.expectedStatus} exhausted=${d.expectedExhausted} backoff=${d.expectsBackoff}\n      actual:   status=${decision.newStatus} exhausted=${decision.exhausted} backoff=${hasBackoff} (class=${decision.classification.class})`;
      console.log(`  ${failure}`);
      failures.push(failure);
    }
  }

  console.log(`\n${total - failures.length}/${total} passed.`);
  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length} failures.`);
    process.exit(1);
  } else {
    console.log(`\n✅ All scenarios pass.`);
  }
}
