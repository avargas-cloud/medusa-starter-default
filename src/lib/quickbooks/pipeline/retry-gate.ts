/**
 * Retry gate for the admin "Retry" button (`post-pipeline.ts`).
 *
 * That button re-dispatches any `qb_order_pipeline` row that is `failed`/`waiting`.
 * Most steps are safe to re-run blindly — a `*Mod`, a `void_*`, or a read-only query
 * can't mint a duplicate document. The steps that CAN mint a duplicate are the ones
 * that ADD a new QuickBooks transaction: re-sending one that already landed creates
 * a second real document — real money, silently doubled.
 *
 * `decideAddRetrySafety` (`add-retry-safety.ts`) already answers "did QuickBooks
 * tell us nothing was created?" for those ADD steps — but it is fail-closed by
 * design: any error text it doesn't recognise comes back `safeToAutoRetry: false`.
 * That's correct for genuine outcome-unknown failures, and WRONG for messages that
 * are deliberate pipeline decisions rather than failures. Measured in production:
 *
 *   - 1337 `sales_order` rows with error
 *     "Superseded by Invoice/Sales Receipt — Sales Order not needed"
 *   - 58 `apply_payment` rows with error
 *     "apply_payment: payment_application voided (invoice INV-20959 voided)"
 *
 * Neither is QuickBooks reporting a failed write — both are OUR code choosing to
 * skip the row. Delegating everything to `decideAddRetrySafety` would block those
 * legitimate retries en masse. So this gate sits IN FRONT of that function and only
 * asks it about the rows that actually need its answer.
 *
 * Pure, no IO — every branch is decided from the row's own fields.
 */
import { decideAddRetrySafety } from "./add-retry-safety";

export type RetryGateInput = {
  step: string;
  status: string; // 'failed' | 'waiting' | other
  error: string | null;
  bridgeOpId: string | null;
  qbTxnId: string | null;
};

export type RetryGateVerdict =
  | { allow: true; reason: string }
  | { allow: false; code: string; reason: string; instructions: string };

/**
 * Steps whose `*Add` mints a brand-new QuickBooks transaction. Everything OUTSIDE
 * this list — read-only queries (`vendor_bill_payment_check`) and every `*_mod` /
 * `void_*` step — is free to retry: there is no document a re-send could duplicate.
 *
 * Load-bearing: the 78 rows that are actually retryable in production today are all
 * `vendor_bill_payment_check`. If the gate blocked those, it would break the only
 * thing the button is currently used for.
 */
export const ADD_CAPABLE_STEPS = [
  "estimate",
  "sales_order",
  "invoice",
  "sales_receipt",
  "credit_memo",
  "payment",
  "apply_payment",
  "write_check",
  "item_receipt_add",
  "vendor_bill_add",
  // Commissions. These two are the reason this gate exists, and the first draft
  // of the list LEFT THEM OUT — because the list was derived from the `switch`
  // in `post-pipeline.ts`, and commission steps have no `case` there (the
  // consolidator dispatches them, not the retry route). Deriving the set of
  // "steps that can mint a document" from a switch that only covers *some* of
  // them is the trap: `commission_check` is a `CheckAdd` and
  // `commission_payment` a `ReceivePaymentAdd`, both non-idempotent, both real
  // money. Caught by `verify-order-commissions.ts`, which exercises the gate
  // with these two steps by NAME rather than trusting the list.
  "commission_check",
  "commission_payment",
] as const;

/**
 * Messages OUR code writes when it decides to skip a row on purpose — not a
 * QuickBooks outcome, so there is no document to duplicate.
 *
 * These are ANCHORED to the phrasings our own code actually emits, censused from
 * production. They are deliberately NOT loose keywords, and that distinction is
 * the whole safety of this branch: it runs BEFORE branch 5, so anything it
 * matches skips the `decideAddRetrySafety` check entirely.
 *
 * A first cut of this list used bare `/already/i`, `/voided/i` and `/skipped/i`.
 * That is a hole, not a shortcut: "already" is ordinary English in error text, so
 * a genuine outcome-unknown failure phrased "the operation may have ALREADY
 * completed but no response was received" would have been waved through without
 * ever consulting the classifier — the exact duplicate this gate exists to stop.
 * Measured: no such row exists in production today, so the risk is structural
 * rather than live. A pattern here must match a sentence we WRITE, not a word
 * QuickBooks might use.
 *
 * Censused families (`status='skipped'`, ADD-capable steps):
 *   1308  "Superseded by Invoice/Sales Receipt — Sales Order not needed"
 *    658  "Superseded by Sales Receipt — payment embedded in SR"
 *    193  "Converted to Sales Order — Estimate not needed"
 *     35  "apply_payment: superseded by payment_application (papp_) sibling row…"
 *     23  "Order canceled before <step> reached QuickBooks" / "Order canceled — …"
 *     12  "A3 cleanup: duplicate cpay_-keyed apply_payment superseded by…"
 *      2  "Invoice permanently skipped — replaced by Sales Receipt…"
 *      2  "Order reverted to draft — Sales Order superseded"
 *      2  "apply_payment: payment_application voided (nothing to apply) — auto-skipped"
 *
 * Deliberately NOT covered, and why: 7 further one-off phrasings exist, one row
 * each ("Duplicate DB row from 2026-06-02 race…", "$0 anchor payment — nothing to
 * record in QB", "Orphan from convert→revert flow…", …). Adding a pattern per
 * sentence is a race nobody wins — the next hand-written skip message would be
 * outside the list again — and every loosening is a chance to leak an
 * outcome-unknown failure into the allow path. Leaving them uncovered costs a
 * 409 that explains itself, on rows that are `skipped` (terminal, and not
 * retryable in the first place: the claim only takes `failed`/`waiting`).
 * Fail-closed on an unfamiliar sentence is the correct trade here.
 */
export const PIPELINE_VERDICT_PATTERNS: RegExp[] = [
  /superseded by /i,
  // "Order reverted to draft — Sales Order superseded" ends on the bare word, so
  // it needs its own anchor. An earlier attempt used /\bsuperseded\b\s*$/, which
  // also matched the lone word "superseded" — narrower than the loose keyword it
  // replaced, but still a shape a failure message could stumble into. Anchoring
  // on the sentence removes the ambiguity entirely.
  /^\s*order reverted to draft\b/i,
  /\bnot needed\b/i,
  /^\s*order canceled\b/i,
  /\bpermanently skipped\b/i,
  /\bauto-skipped\b/i,
  /\bpayment_application voided\b/i,
];

function matchesPipelineVerdict(error: string | null): boolean {
  const message = (error ?? "").trim();
  if (!message) return false;
  return PIPELINE_VERDICT_PATTERNS.some((rx) => rx.test(message));
}

/**
 * Decides whether the admin Retry button may re-dispatch a `qb_order_pipeline`
 * row. Order is the specification — evaluate in this exact sequence.
 */
export function evaluateRetryGate(input: RetryGateInput): RetryGateVerdict {
  const { step, error, bridgeOpId, qbTxnId } = input;

  // 1. Step can't duplicate a document — free to retry.
  if (!(ADD_CAPABLE_STEPS as readonly string[]).includes(step)) {
    return {
      allow: true,
      reason: `"${step}" cannot mint a duplicate document (not in ADD_CAPABLE_STEPS) — safe to retry.`,
    };
  }

  // 2. A pipeline verdict, not a failure — our own code chose to skip this row;
  // it never describes a QuickBooks outcome, so there is no document to duplicate.
  if (matchesPipelineVerdict(error)) {
    return {
      allow: true,
      reason: `Error text matches a pipeline verdict, not a QuickBooks outcome: "${(
        error ?? ""
      ).trim()}" — safe to retry.`,
    };
  }

  // 3. ADD-capable step with a qbTxnId already recorded — the retry goes to MOD,
  // not ADD. `post-pipeline.ts`'s claim only preserves `qb_txn_id` for
  // `estimate`/`invoice`/`sales_order` — the three steps whose retry can be either
  // an ADD or a MOD. A TxnID present means the document already exists, so the
  // retry will modify it, not create it. This is the signal that avoids needing a
  // persisted `operation_kind` column, which would be a migration and is out of
  // scope here.
  if (qbTxnId) {
    return {
      allow: true,
      reason:
        "qbTxnId is already recorded — the retry goes to MOD, not ADD, so there is nothing to duplicate.",
    };
  }

  // 4. ADD-capable step with no bridgeOpId — it never reached the bridge, so there
  // was never a submit and no document is possible in QuickBooks.
  if (!bridgeOpId) {
    return {
      allow: true,
      reason: "No bridgeOpId recorded — this row never reached the bridge, so retrying cannot duplicate anything.",
    };
  }

  // 5. ADD-capable step WITH a bridgeOpId — defer to decideAddRetrySafety.
  if (bridgeOpId) {
    const decision = decideAddRetrySafety(error);
    if (decision.safeToAutoRetry) {
      return {
        allow: true,
        reason: `QuickBooks answered with an error (${decision.reason}) — nothing was created, so a retry is safe.`,
      };
    }

    return {
      allow: false,
      code: "retry_needs_qb_verification",
      reason: decision.reason,
      instructions:
        "The outcome in QuickBooks is unknown. The bridge's dedup ledger only protects while the op stays in its in-memory " +
        "window — it is purged after 6 hours and lost on a process restart, so it cannot be trusted to catch a duplicate here. " +
        "Verify in QuickBooks whether the document already exists before retrying. For checks, query by EntityFilter with the " +
        "vendor's ListID — NOT by RefNumber: QuickBooks never assigns a RefNumber to a check created with IsToBePrinted=true, " +
        "so a RefNumber search returns a false negative.",
    };
  }

  // 6. Default final. Given branches 1-5 above, every combination of
  // (ADD_CAPABLE_STEPS membership, pipeline-verdict match, qbTxnId, bridgeOpId) is
  // already decided — this is the explicit fail-closed fallback the spec asks for:
  // if the shape of a row ever matches none of the branches above, do not guess.
  return {
    allow: false,
    code: "retry_gate_unclassified",
    reason: "This row's shape did not match any recognised retry-gate branch.",
    instructions:
      "Reconcile this row manually before retrying — its combination of step/error/bridgeOpId/qbTxnId was not covered by " +
      "the gate's decision table.",
  };
}
