/**
 * src/lib/quickbooks/sync-enabled.ts
 *
 * One global switch: `QB_SYNC_ENABLED`. Unset (or anything other than the
 * literal string `"false"`) means ENABLED — production must not change
 * behavior until an operator explicitly flips it to `"false"`. This mirrors
 * the fail-open-by-default shape of `isScheduledJobsDisabled`
 * (`src/jobs/_lib/_scheduled-jobs-guard.ts`), except this switch is
 * fail-OPEN (sync stays on) rather than fail-closed, because turning QB sync
 * off is an operator decision, never an accident of an unset env var.
 *
 * When OFF:
 *   - every writer of a `qb_*_pipeline` row must skip the insert and return a
 *     harmless "skipped" sentinel instead
 *   - every `src/jobs/qb-*.ts` / `src/subscribers/qb-*` must return immediately
 *   - every synchronous call into the QB bridge must never leave this
 *     process — `bridge-fetch.ts` throws `QbSyncDisabledError` before any
 *     network call
 *
 * This file is the single source of truth for the "is it on" question — no
 * caller re-reads `process.env.QB_SYNC_ENABLED` directly.
 */

const DISABLED_VALUES = new Set(["false", "0", "off"]);

/**
 * `true` when QuickBooks sync is enabled — the default when the env var is
 * unset or holds any value other than the recognized "off" spellings.
 */
export function isQbSyncEnabled(): boolean {
  const raw = process.env.QB_SYNC_ENABLED;
  if (raw === undefined) return true;
  return !DISABLED_VALUES.has(raw.trim().toLowerCase());
}

/** Thrown by `bridge-fetch.ts` instead of reaching the network when sync is off. */
export class QbSyncDisabledError extends Error {
  readonly code = "QB_SYNC_DISABLED" as const;

  constructor(message = "QuickBooks sync is disabled (QB_SYNC_ENABLED=false)") {
    super(message);
    this.name = "QbSyncDisabledError";
  }
}
