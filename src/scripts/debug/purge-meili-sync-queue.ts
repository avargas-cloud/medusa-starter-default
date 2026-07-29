/**
 * Manual runner for the `meili_sync_queue` retention purge.
 *
 * Read-only unless you ask for otherwise: DRY-RUN is the default and you must
 * pass APPLY=true to delete anything. The dry run prints the exact write set —
 * how many rows, which id range, broken down by entity — which is what makes an
 * approval checkpoint before a production run mean something.
 *
 * Run (sandbox):
 *   env DATABASE_URL=postgres://…:5499/… ./node_modules/.bin/medusa exec \
 *     ./src/scripts/debug/purge-meili-sync-queue.ts
 *
 * Run (production — pass env EXPLICITLY; the Avernuz xterm leaks a DATABASE_URL
 * pointing at 127.0.0.1:5500 and you will hit the wrong database):
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) APPLY=true \
 *     ./node_modules/.bin/medusa exec ./src/scripts/debug/purge-meili-sync-queue.ts
 *
 * Env: MEILI_QUEUE_RETENTION_DAYS (default 30) · APPLY=true · MAX_ROWS · BATCH_SIZE
 *
 * NOTE: `src/scripts` is excluded from `yarn type-check` — this file is only
 * validated by running it. The logic it calls lives in `src/lib` and IS checked.
 */
import type { ExecArgs } from "@medusajs/framework/types";
import postgres from "postgres";

import {
  formatPurgeResult,
  purgeSyncQueue,
  resolveRetentionDays,
} from "../../lib/meilisearch/purge-sync-queue";

const optionalInt = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`expected a whole number >= 0, got ${JSON.stringify(raw)}`);
  }
  return parsed;
};

export default async function purgeMeiliSyncQueue({ container }: ExecArgs) {
  const logger = container.resolve("logger");

  const apply = process.env.APPLY === "true";
  const retentionDays = resolveRetentionDays(process.env.MEILI_QUEUE_RETENTION_DAYS);
  const maxRows = optionalInt(process.env.MAX_ROWS);
  const batchSize = optionalInt(process.env.BATCH_SIZE);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");

  // Say out loud which database this is about to touch. The whole class of
  // "it ran against the wrong DB" incidents starts with this line missing.
  const target = databaseUrl.replace(/\/\/[^@]*@/, "//***@");
  logger.info(`[purge-runner] target=${target}`);
  logger.info(`[purge-runner] mode=${apply ? "APPLY (will delete)" : "DRY-RUN (no writes)"}`);

  const sql = postgres(databaseUrl, {
    max: 1,
    connection: { application_name: "meili-queue-purge-runner" },
  });

  try {
    // ── Before: the shape of the table, and the write set in detail ──────
    const [before] = await sql<
      { processed: string; pending: string; dead_letter: string; total: string }[]
    >`
      SELECT count(*) FILTER (WHERE processed_at IS NOT NULL)::text AS processed,
             count(*) FILTER (WHERE processed_at IS NULL)::text     AS pending,
             count(*) FILTER (WHERE processed_at IS NULL
                                AND attempt_count >= 5)::text       AS dead_letter,
             count(*)::text                                         AS total
      FROM meili_sync_queue
    `;
    logger.info(
      `[purge-runner] before: total=${before?.total} processed=${before?.processed} ` +
        `pending=${before?.pending} dead_letter=${before?.dead_letter}`
    );

    const writeSet = await sql<{ entity_type: string; rows: string; min_id: string; max_id: string }[]>`
      SELECT entity_type,
             count(*)::text  AS rows,
             min(id)::text   AS min_id,
             max(id)::text   AS max_id
      FROM meili_sync_queue
      WHERE processed_at IS NOT NULL
        AND processed_at < now() - make_interval(days => ${retentionDays})
      GROUP BY entity_type
      ORDER BY count(*) DESC
    `;
    if (writeSet.length === 0) {
      logger.info(`[purge-runner] write set is empty at ${retentionDays}d retention`);
    }
    for (const row of writeSet) {
      logger.info(
        `[purge-runner]   ${row.entity_type}: ${row.rows} row(s), id ${row.min_id}..${row.max_id}`
      );
    }

    // ── The run ──────────────────────────────────────────────────────────
    const result = await purgeSyncQueue(sql, {
      retentionDays,
      dryRun: !apply,
      ...(maxRows !== undefined ? { maxRows } : {}),
      ...(batchSize !== undefined ? { batchSize } : {}),
    });
    logger.info(`[purge-runner] ${formatPurgeResult(result)}`);

    // ── After: the assertion that matters is that pending did not move ────
    const [after] = await sql<{ processed: string; pending: string; total: string }[]>`
      SELECT count(*) FILTER (WHERE processed_at IS NOT NULL)::text AS processed,
             count(*) FILTER (WHERE processed_at IS NULL)::text     AS pending,
             count(*)::text                                         AS total
      FROM meili_sync_queue
    `;
    logger.info(
      `[purge-runner] after:  total=${after?.total} processed=${after?.processed} ` +
        `pending=${after?.pending}`
    );

    // `pending` can legitimately GROW mid-run (live triggers keep enqueueing) or
    // SHRINK (the processor drains). It must never shrink *because of us* — and
    // we only ever delete processed rows, so a drop here is worth reporting, not
    // asserting on. The hard check is that the processed delta matches exactly.
    const processedDelta = Number(before?.processed ?? 0) - Number(after?.processed ?? 0);
    if (apply && processedDelta !== result.deleted) {
      logger.warn(
        `[purge-runner] ⚠️  processed dropped by ${processedDelta} but we deleted ` +
          `${result.deleted} — the processor stamped rows mid-run, or something else wrote`
      );
    }
    if (!apply) {
      logger.info(`[purge-runner] DRY-RUN complete — nothing was deleted. Re-run with APPLY=true.`);
    }
  } finally {
    await sql.end();
  }
}
