/**
 * Centralized retry configuration for QB pipeline pollers.
 *
 * Why: each poller used to define its own backoff schedule, leading to
 * inconsistencies (vendor used [2,4,8] while others used [2,4,10,30,60]).
 * This module is the single source of truth.
 */

/**
 * Standard exponential-ish backoff (minutes) for QB pipeline retries.
 * After exhausting this list, rows transition to `failed_permanent`.
 *
 * Total tolerance: ~106 minutes across 5 attempts.
 */
export const STANDARD_BACKOFF_MINUTES = [2, 4, 10, 30, 60] as const;

/**
 * Maximum number of retries before a row is marked `failed_permanent`.
 * Equals the length of the backoff schedule.
 */
export const MAX_RETRIES = STANDARD_BACKOFF_MINUTES.length;

/**
 * Compute the next retry timestamp given how many retries already happened.
 * Caps at the last entry of the schedule.
 *
 * @param retriesSoFar number of retries already attempted (0 = first failure)
 * @param schedule optional override
 */
export function computeNextRetryDate(
  retriesSoFar: number,
  schedule: readonly number[] = STANDARD_BACKOFF_MINUTES
): Date {
  const idx = Math.min(Math.max(retriesSoFar, 0), schedule.length - 1);
  const minutes = schedule[idx] ?? schedule[schedule.length - 1] ?? 60;
  return new Date(Date.now() + minutes * 60_000);
}

/**
 * Returns true if the given retry count has exhausted the schedule.
 * Use this to decide whether to mark a row as `failed_permanent`.
 */
export function isRetryExhausted(
  retriesSoFar: number,
  schedule: readonly number[] = STANDARD_BACKOFF_MINUTES
): boolean {
  return retriesSoFar >= schedule.length;
}

import { classifyQbError, type QbErrorClassification } from "./error-classifier";

/**
 * Outcome of a retry decision. Caller is responsible for issuing the SQL
 * UPDATE — this function stays pure so it is trivially testable and can
 * coexist with both knex.raw (`?`-style) and pg Pool (`$1`-style) call sites.
 */
export interface RetryDecision {
  /** New status to write on the pipeline row. */
  newStatus: "error" | "failed_permanent" | "failed";
  /** Backoff target. null = either permanent failure or feature-flagged off. */
  nextRetryAt: Date | null;
  /** True if the error budget is spent (transient → permanent). */
  exhausted: boolean;
  /** Forward-pass of the classifier output for logging / branching. */
  classification: QbErrorClassification;
  /** retries column to write (caller-supplied retriesSoFar + 1). */
  newRetries: number;
}

export interface DecideRetryArgs {
  error: { message?: string | null; code?: string | number | null };
  retriesSoFar: number;
  /**
   * Schema feature flag: does the target table have `next_retry_at`?
   * - `qb_item_pipeline`           → true
   * - `qb_purchase_order_pipeline` → true
   * - `qb_order_pipeline`          → false in Phase 1 (true after Phase 2 migration)
   */
  hasNextRetryAt: boolean;
  /**
   * Schema feature flag: does the target table accept `failed_permanent`?
   * Same Phase-1/Phase-2 split as `hasNextRetryAt`.
   */
  hasFailedPermanent: boolean;
  /** Optional override for the backoff schedule (defaults to STANDARD_BACKOFF_MINUTES). */
  schedule?: readonly number[];
}

/**
 * Decide what state a pipeline row should transition to after an error.
 *
 * Pure function — does not touch the database. Caller writes the UPDATE
 * using `decision.newStatus`, `decision.nextRetryAt`, and `decision.newRetries`.
 *
 * Phase-1 fallback: when `hasNextRetryAt=false` (current `qb_order_pipeline`),
 * transient errors still resolve to `failed` (matching legacy behavior).
 * After the Phase-2 schema migration adds `next_retry_at`, callers should
 * pass `hasNextRetryAt=true` and transient errors will route to `error`
 * with a backoff timestamp.
 *
 * Behavior matrix:
 *   transient & not exhausted & hasNextRetryAt    → "error"            + backoff
 *   transient & not exhausted & !hasNextRetryAt   → "failed"           + null   (Phase-1 compat)
 *   transient & exhausted     & hasFailedPermanent → "failed_permanent" + null
 *   transient & exhausted     & !hasFailedPermanent → "failed"          + null
 *   !transient                & hasFailedPermanent → "failed_permanent" + null
 *   !transient                & !hasFailedPermanent → "failed"          + null
 */
export function decideRetry(args: DecideRetryArgs): RetryDecision {
  const classification = classifyQbError(args.error);
  const newRetries = Math.max(args.retriesSoFar, 0) + 1;
  const schedule = args.schedule ?? STANDARD_BACKOFF_MINUTES;
  const exhausted = isRetryExhausted(newRetries - 1, schedule);

  const finalFailureStatus: RetryDecision["newStatus"] = args.hasFailedPermanent
    ? "failed_permanent"
    : "failed";

  if (!classification.isTransient) {
    return {
      newStatus: finalFailureStatus,
      nextRetryAt: null,
      exhausted: true,
      classification,
      newRetries,
    };
  }
  if (exhausted) {
    return {
      newStatus: finalFailureStatus,
      nextRetryAt: null,
      exhausted: true,
      classification,
      newRetries,
    };
  }
  if (!args.hasNextRetryAt) {
    // Phase-1 compatibility: target table cannot store backoff yet.
    // Caller will mark `failed` (legacy behavior). Phase 2 migration removes
    // this branch by setting hasNextRetryAt=true on qb_order_pipeline callers.
    return {
      newStatus: "failed",
      nextRetryAt: null,
      exhausted: false,
      classification,
      newRetries,
    };
  }
  return {
    newStatus: "error",
    nextRetryAt: computeNextRetryDate(newRetries - 1, schedule),
    exhausted: false,
    classification,
    newRetries,
  };
}
