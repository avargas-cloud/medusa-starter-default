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
