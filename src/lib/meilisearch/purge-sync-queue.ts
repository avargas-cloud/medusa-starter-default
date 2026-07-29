/**
 * Retention purge for `meili_sync_queue`.
 *
 * What this table is — and what it is NOT. `meili_sync_queue` holds no search
 * data. It is a to-do list: a Postgres trigger appends a row saying "entity X
 * changed, re-sync its document", `meili-sync-queue-processor` does the work and
 * stamps `processed_at`. The order itself lives in `order`; its searchable copy
 * lives in the Meili `orders` index. Deleting a stamped row removes a completed
 * reminder, nothing else — no entity ever becomes unsearchable because of it.
 * Measured 2026-07-29: order #1332 (the oldest in the system, April) is fully
 * indexed and has never had a single row here.
 *
 * What IS lost is the forensic trail — `source_hint` records which connection
 * wrote, so a purged row can no longer answer "why did this re-sync 40 times in
 * June?". That, and only that, is what the retention window buys.
 *
 * Two invariants this file exists to hold:
 *
 *   1. A row with `processed_at IS NULL` is NEVER touched. That state means
 *      either still-pending or dead-lettered (`attempt_count >= MAX_ATTEMPTS`,
 *      which the processor leaves NULL forever so ops can find it). Both are
 *      live work. Every statement below carries `processed_at IS NOT NULL`, and
 *      a unit test asserts that no statement naming this table can omit it.
 *
 *   2. Deletion walks forward in batches with a cursor on `id`, committing each
 *      batch. Never one long transaction: order/product/customer/inventory
 *      triggers write to this table continuously, so holding locks across 17k
 *      rows would stall live writes.
 *
 * Why no index on `processed_at` — measured, not assumed. `id` is BIGSERIAL and
 * rows are processed ~1 minute after being queued, so the eligible set is a
 * contiguous prefix of the primary key (on 2026-07-29 the 30-day set was exactly
 * `id 1..17245`). The batch query walks the pkey from the cursor and matches on
 * the first rows it touches. A plain `DELETE ... WHERE processed_at < cutoff`
 * would seq-scan; this does not. An extra index would cost a write on every one
 * of the ~900 daily inserts to buy nothing. Revisit only if a run's per-batch
 * duration (logged) actually degrades.
 *
 * The cursor also covers the one case that would break that correlation: a
 * dead-letter row stuck at the front stays `processed_at IS NULL` forever, so it
 * never matches, and the cursor advances past it instead of re-scanning it on
 * every batch.
 */
import type { Sql } from "postgres";

/** Matches the operator decision of 2026-07-29. Overridable per call / by env. */
export const DEFAULT_RETENTION_DAYS = 30;
/** Rows per committed batch. Small enough that a batch is milliseconds. */
export const DEFAULT_BATCH_SIZE = 1_000;
/** Hard ceiling per run, so a misconfiguration can't churn the table for hours. */
export const DEFAULT_MAX_ROWS = 100_000;
/** Breather between batches — the table is written by live triggers. */
export const DEFAULT_PAUSE_MS = 50;

export interface PurgeSyncQueueOptions {
  retentionDays?: number;
  batchSize?: number;
  maxRows?: number;
  pauseMs?: number;
  /** Count what would go, delete nothing. */
  dryRun?: boolean;
}

export interface PurgeSyncQueueResult {
  retentionDays: number;
  /** The resolved absolute cutoff, so a log line is reproducible after the fact. */
  cutoff: string;
  /** Rows matching the predicate when the run started. */
  eligible: number;
  deleted: number;
  batches: number;
  /** True when `maxRows` stopped the run before the eligible set was exhausted. */
  cappedByMaxRows: boolean;
  dryRun: boolean;
  durationMs: number;
}

/**
 * Reject anything that isn't a whole number of days >= 1.
 *
 * Deliberately throws instead of falling back to the default: `0` would mean
 * "delete every processed row" and `-7` would mean "delete rows from the
 * future", and both are one typo away in an env var. Refusing to run is the
 * safe direction — the job logs the error and the next night tries again.
 */
export function assertRetentionDays(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `[meili-queue-purge] retentionDays must be a whole number >= 1, got ${JSON.stringify(value)}`
    );
  }
  return value;
}

/** Parse `MEILI_QUEUE_RETENTION_DAYS`; absent/empty falls back to the default. */
export function resolveRetentionDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_RETENTION_DAYS;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `[meili-queue-purge] MEILI_QUEUE_RETENTION_DAYS is not a number: ${JSON.stringify(raw)}`
    );
  }
  return assertRetentionDays(parsed);
}

const maxId = (rows: readonly { id: string }[]): string => {
  let max = 0n;
  for (const row of rows) {
    const value = BigInt(row.id);
    if (value > max) max = value;
  }
  return max.toString();
};

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

export async function purgeSyncQueue(
  sql: Sql,
  options: PurgeSyncQueueOptions = {}
): Promise<PurgeSyncQueueResult> {
  const retentionDays = assertRetentionDays(options.retentionDays ?? DEFAULT_RETENTION_DAYS);
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const maxRows = Math.max(0, options.maxRows ?? DEFAULT_MAX_ROWS);
  const pauseMs = Math.max(0, options.pauseMs ?? DEFAULT_PAUSE_MS);
  const dryRun = options.dryRun ?? false;
  const startedAt = Date.now();

  // Resolve the cutoff ONCE. Re-deriving `now() - interval` inside each batch
  // would drift by milliseconds between statements, which makes a run
  // irreproducible and makes "eligible == deleted" untestable.
  const cutoffRows = await sql<{ cutoff: string }[]>`
    SELECT (now() - make_interval(days => ${retentionDays}))::text AS cutoff
  `;
  const cutoff = cutoffRows[0]?.cutoff ?? "";
  if (!cutoff) {
    throw new Error("[meili-queue-purge] could not resolve the retention cutoff");
  }

  const eligibleRows = await sql<{ eligible: string }[]>`
    SELECT count(*)::text AS eligible
    FROM meili_sync_queue
    WHERE processed_at IS NOT NULL
      AND processed_at < ${cutoff}::timestamptz
  `;
  const eligible = Number(eligibleRows[0]?.eligible ?? 0);

  const base = {
    retentionDays,
    cutoff,
    eligible,
    dryRun,
  };

  if (dryRun || eligible === 0 || maxRows === 0) {
    return {
      ...base,
      deleted: 0,
      batches: 0,
      cappedByMaxRows: !dryRun && maxRows === 0 && eligible > 0,
      durationMs: Date.now() - startedAt,
    };
  }

  let cursor = "0";
  let deleted = 0;
  let batches = 0;
  let cappedByMaxRows = false;

  for (;;) {
    const remaining = maxRows - deleted;
    if (remaining <= 0) {
      cappedByMaxRows = true;
      break;
    }
    const limit = Math.min(batchSize, remaining);

    // One statement = one implicit transaction = one commit per batch.
    // No FOR UPDATE SKIP LOCKED needed: the processor only ever claims rows
    // WHERE processed_at IS NULL, which is exactly the set excluded here.
    const victims = await sql<{ id: string }[]>`
      WITH victims AS (
        SELECT id
        FROM meili_sync_queue
        WHERE id > ${cursor}::bigint
          AND processed_at IS NOT NULL
          AND processed_at < ${cutoff}::timestamptz
        ORDER BY id
        LIMIT ${limit}
      )
      DELETE FROM meili_sync_queue q
      USING victims v
      WHERE q.id = v.id
      RETURNING q.id::text AS id
    `;

    if (victims.length === 0) break;

    batches += 1;
    deleted += victims.length;
    cursor = maxId(victims);

    if (victims.length < limit) break;
    await sleep(pauseMs);
  }

  return {
    ...base,
    deleted,
    batches,
    cappedByMaxRows,
    durationMs: Date.now() - startedAt,
  };
}

/** One-line summary for a log entry or a terminal report. */
export function formatPurgeResult(result: PurgeSyncQueueResult): string {
  const mode = result.dryRun ? "DRY-RUN " : "";
  const capped = result.cappedByMaxRows ? " CAPPED(maxRows)" : "";
  return (
    `${mode}retention=${result.retentionDays}d cutoff=${result.cutoff} ` +
    `eligible=${result.eligible} deleted=${result.deleted} ` +
    `batches=${result.batches} took=${result.durationMs}ms${capped}`
  );
}
