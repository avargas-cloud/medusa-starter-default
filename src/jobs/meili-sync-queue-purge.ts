/**
 * Nightly retention purge of `meili_sync_queue`.
 *
 * The queue is append-only and had never been purged: 47.786 processed rows on
 * 2026-07-29, the oldest from 2026-05-25, growing ~900/day (bursts to 3.672).
 * Nothing reads a processed row — verified by grep, the only other mentions of
 * the table in `src/` are comments — so retention is pure hygiene, not a fix for
 * a live problem. Left alone the table reaches ~330k rows / ~90 MB in a year.
 *
 * Every safety property lives in `purgeSyncQueue` (never touches
 * `processed_at IS NULL`, batches with a commit per batch, hard row cap). This
 * file only wires it to a schedule and a connection.
 *
 * Retention is `MEILI_QUEUE_RETENTION_DAYS`, default 30 — an env change on
 * Railway, no deploy. An invalid value throws rather than falling back, so a
 * typo fails loudly tonight instead of quietly deleting more than intended.
 */
import type { MedusaContainer } from "@medusajs/framework/types";
import postgres from "postgres";

import {
  formatPurgeResult,
  purgeSyncQueue,
  resolveRetentionDays,
} from "../lib/meilisearch/purge-sync-queue";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";

export default async function meiliSyncQueuePurge(
  container: MedusaContainer
): Promise<void> {
  if (isScheduledJobsDisabled(container)) return;

  const logger = container.resolve("logger");

  if (!process.env.DATABASE_URL) {
    logger.warn("[meili-queue-purge] no DATABASE_URL — skipping");
    return;
  }

  let retentionDays: number;
  try {
    retentionDays = resolveRetentionDays(process.env.MEILI_QUEUE_RETENTION_DAYS);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[meili-queue-purge] bad retention config, not purging: ${message}`);
    return;
  }

  const sql = postgres(process.env.DATABASE_URL, {
    max: 1,
    connection: { application_name: "meili-queue-purge" },
  });

  try {
    const result = await purgeSyncQueue(sql, { retentionDays });
    logger.info(`[meili-queue-purge] ${formatPurgeResult(result)}`);

    // A capped run means the backlog outran one night. Harmless (tomorrow takes
    // the next slice) but worth seeing, since it also means the row cap is now
    // the thing deciding the retention, not the window.
    if (result.cappedByMaxRows) {
      logger.warn(
        `[meili-queue-purge] hit the per-run row cap with ${result.eligible - result.deleted} ` +
          `row(s) still eligible — the next run will continue`
      );
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[meili-queue-purge] purge failed: ${message}`);
  } finally {
    await sql.end();
  }
}

/**
 * Daily at 04:10. Sits after `qb-bridge-auto-purge` (03:30) so the two
 * maintenance jobs don't share a window, and in the quietest stretch for writes
 * to the watched tables.
 */
export const config = {
  name: "meili-sync-queue-purge",
  schedule: "10 4 * * *",
};
