/**
 * Retry safety for non-idempotent QuickBooks `*Add` operations.
 *
 * A `ReceivePaymentAdd` (how a credit memo gets applied to an invoice) creates a
 * document. Re-sending one that already landed mints a duplicate — real money,
 * silently doubled. So "the step failed, retry it" is only safe when we KNOW
 * QuickBooks created nothing.
 *
 * That splits every failure into two families:
 *
 *   QB ANSWERED with an error code  → the request was rejected, no document
 *                                     exists, retrying is safe.
 *   OUTCOME UNKNOWN (timeout, dropped connection, response with no TxnID,
 *   QBWC never polled)              → QuickBooks may hold a document we never
 *                                     recorded. Auto-retry would duplicate it.
 *
 * The second family stops and stays visible for a human, on purpose: trading a
 * visible block for a possible duplicate payment is the wrong trade.
 *
 * Pairs with `Idempotency-Key` on the ADD, which lets the bridge collapse a
 * re-send into the original op — but only inside its 6h ledger window, and never
 * for ops it already marked `failed`. The key narrows the window; it does not
 * remove the need for this decision.
 */
import { classifyQbError } from "../error-classifier";

/**
 * Error classes that mean "we never learned what QuickBooks did".
 * `parser_failed` is the sharpest case: the op completed, but the response
 * carried no TxnID — QB may well have created the document.
 */
const UNKNOWN_OUTCOME_CLASSES = new Set([
  "network",
  "bridge_busy",
  "parser_failed",
]);

/** Transport-level phrasings that never reach a QB verdict. */
const RX_UNKNOWN_OUTCOME =
  /timed out|timeout|aborted|no response|connection (reset|closed)|before submitted state/i;

export type AddRetryDecision = {
  /** Safe to schedule an automatic retry of this ADD. */
  safeToAutoRetry: boolean;
  /** Operator-facing explanation, surfaced on the pipeline row. */
  reason: string;
};

/**
 * Decides whether a failed QB `*Add` may be retried automatically.
 *
 * Defaults to `false` for anything unrecognisable — when the shape of a failure
 * is unknown, so is its outcome.
 */
export function decideAddRetrySafety(error: string | null): AddRetryDecision {
  const message = (error ?? "").trim();

  if (!message) {
    return {
      safeToAutoRetry: false,
      reason:
        "Outcome unknown (no error detail recorded) — the ADD may already exist in QuickBooks. Reconcile before retrying.",
    };
  }

  const classification = classifyQbError({ message });

  if (UNKNOWN_OUTCOME_CLASSES.has(classification.class)) {
    return {
      safeToAutoRetry: false,
      reason:
        `Outcome unknown (${classification.class}) — QuickBooks may have created the document without us recording it. ` +
        `Reconcile against QB, then retry manually.`,
    };
  }

  if (RX_UNKNOWN_OUTCOME.test(message)) {
    return {
      safeToAutoRetry: false,
      reason:
        "Outcome unknown (no verdict from QuickBooks) — the ADD may already exist. Reconcile against QB, then retry manually.",
    };
  }

  if (classification.code || classification.class !== "permanent") {
    return {
      safeToAutoRetry: true,
      reason: `QuickBooks rejected the request (${classification.class}${
        classification.code ? ` ${classification.code}` : ""
      }) — nothing was created, so a retry is safe.`,
    };
  }

  return {
    safeToAutoRetry: false,
    reason:
      "Unrecognised failure — outcome cannot be established. Reconcile against QB before retrying.",
  };
}
