import { getDbPool } from "../../../api/utils/db-pool";
import { bridgeFetch } from "../client/core";
import { invalidateEditSequenceCache } from "../qb-pipeline";

const LOG_PREFIX = "[QB-CONSOLIDATOR]";

/**
 * Timeout pass: pending/processing rows stuck for >20 minutes are marked failed.
 * Covers cases where the async QB call threw before ever reaching 'submitted'
 * (e.g. bad query.graph fields, network error, bridge down).
 */
export async function runTimeoutPass(logger: any): Promise<void> {
  const pool = getDbPool();
  try {
    const { rows: timedOutRows, rowCount } = await pool.query(`
            UPDATE qb_order_pipeline
            SET    status        = 'failed',
                   updated_at    = NOW(),
                   error         = 'Timed out before submitted state (>20 min) — no response from QB bridge',
                   failed_at     = NOW(),
                   -- Schedule auto-retry so the row doesn't sit failed-forever.
                   -- Same backoff envelope as get-pipeline auto-timeout: 2 min,
                   -- capped at 5 retries (beyond that it needs manual triage).
                   next_retry_at = CASE
                     WHEN COALESCE(retry_count, 0) < 5
                       THEN NOW() + INTERVAL '2 minutes'
                     ELSE NULL
                   END
            WHERE  status IN ('pending', 'processing')
              AND  COALESCE(updated_at, created_at) < NOW() - INTERVAL '20 minutes'
            RETURNING id, step, order_id
        `);
    if (rowCount && rowCount > 0) {
      for (const r of timedOutRows) {
        logger.warn(
          `${LOG_PREFIX} ⏱️ Timed-out pending row → failed: id=${r.id} step=${r.step} order=${r.order_id}`
        );
      }
    }
  } catch (timeoutErr: unknown) {
    const msg =
      timeoutErr instanceof Error ? timeoutErr.message : String(timeoutErr);
    logger.warn(`${LOG_PREFIX} ⚠️ Timeout pass error: ${msg}`);
  }
}

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

/**
 * Stale submitted cleanup: rows stuck in 'submitted' for >30 minutes are
 * marked failed and their EditSequence cache is invalidated so stale sequences
 * aren't reused on the next retry.
 *
 * IMPORTANT: before marking a row as failed, we poll the bridge for the
 * outstanding bridge_op_id. If the op is still pending/processing we extend
 * the submitted window instead of giving up — a blind fail while the bridge is
 * still working causes a duplicate document in QB on the next retry.
 * We only force-fail after 2 hours of pending bridge status.
 */
export async function runStaleSubmittedCleanup(logger: any): Promise<void> {
  const pool = getDbPool();
  try {
    const { rows: staleSubmitted } = await pool.query(
      `SELECT id, step, qb_txn_id, bridge_op_id, submitted_at
       FROM qb_order_pipeline
       WHERE status = 'submitted' AND updated_at < NOW() - INTERVAL '30 minutes'`
    );

    for (const row of staleSubmitted) {
      if (row.bridge_op_id) {
        let shouldFail = false;
        try {
          const statusRes = await bridgeFetch(
            "GET",
            `/api/sync/status/${row.bridge_op_id}`
          );
          const opStatus = statusRes?.operation?.status as string | undefined;

          if (opStatus === "pending" || opStatus === "processing") {
            const submittedMs = row.submitted_at
              ? Date.now() - new Date(row.submitted_at as string).getTime()
              : Infinity;
            if (submittedMs < TWO_HOURS_MS) {
              // Bridge is still working — extend the window to prevent a
              // premature fail that would trigger a duplicate QB submission.
              await pool.query(
                `UPDATE qb_order_pipeline SET updated_at = NOW() WHERE id = $1`,
                [row.id]
              );
              logger.info(
                `${LOG_PREFIX} ⏳ Row ${row.id} (step=${row.step}) bridge op ${row.bridge_op_id} still ${opStatus} — extending window`
              );
              continue;
            }
            // Pending for >2 hours — abandon
            logger.warn(
              `${LOG_PREFIX} ⏱️ Row ${row.id} (step=${row.step}) bridge op pending >2h — marking failed`
            );
            shouldFail = true;
          } else if (opStatus === "completed") {
            // Bridge completed but the confirmation callback was missed (e.g.
            // server restart). Reset updated_at so the poll loop picks it up.
            await pool.query(
              `UPDATE qb_order_pipeline SET updated_at = NOW() WHERE id = $1`,
              [row.id]
            );
            logger.info(
              `${LOG_PREFIX} ✅ Row ${row.id} (step=${row.step}) bridge op already completed — will confirm on next poll`
            );
            continue;
          } else {
            // Bridge says failed or op not found — fall through to mark failed
            shouldFail = true;
          }
        } catch (bridgeErr: any) {
          // Bridge unreachable — be conservative and leave as submitted
          logger.warn(
            `${LOG_PREFIX} ⚠️ Could not reach bridge for row ${row.id}: ${bridgeErr.message} — leaving submitted`
          );
          continue;
        }
        if (!shouldFail) continue;
      }

      // No bridge_op_id, bridge says failed/not-found, or op pending >2h
      await pool.query(
        `UPDATE qb_order_pipeline
         SET    status       = 'failed',
                error        = 'Stale: no bridge confirmation after 30 minutes',
                updated_at   = NOW(),
                failed_at    = NOW(),
                confirmed_at = NULL
         WHERE  id = $1`,
        [row.id]
      );
      logger.warn(
        `${LOG_PREFIX} ⏱️ Marked stale submitted row ${row.id} (step=${row.step}) as failed`
      );
      if (row.qb_txn_id) {
        await invalidateEditSequenceCache(
          row.step as string,
          row.qb_txn_id as string
        ).catch(() => {});
      }
    }
  } catch (staleSubmittedErr: unknown) {
    const msg =
      staleSubmittedErr instanceof Error
        ? staleSubmittedErr.message
        : String(staleSubmittedErr);
    logger.warn(`${LOG_PREFIX} ⚠️ Stale submitted cleanup error: ${msg}`);
  }
}

/**
 * Stale pending/processing cleanup: rows stuck before bridge submission for >20 minutes are marked
 * failed with individual log entries (complements the timeout pass batch update).
 */
export async function runStalePendingCleanup(logger: any): Promise<void> {
  const pool = getDbPool();
  try {
    const { rows: stalePending } = await pool.query(
      `UPDATE qb_order_pipeline
             SET status = 'failed', error = 'Stale: never submitted within 20 minutes', updated_at = NOW(), failed_at = NOW(), confirmed_at = NULL
             WHERE status IN ('pending', 'processing') AND updated_at < NOW() - INTERVAL '20 minutes'
             RETURNING id, step, status`
    );
    for (const row of stalePending) {
      logger.warn(
        `${LOG_PREFIX} ⏱️ Marked stale ${row.status} row ${row.id} (step=${row.step}) as failed`
      );
    }
  } catch (stalePendingErr: unknown) {
    const msg =
      stalePendingErr instanceof Error
        ? stalePendingErr.message
        : String(stalePendingErr);
    logger.warn(`${LOG_PREFIX} ⚠️ Stale pending cleanup error: ${msg}`);
  }
}
