import { getDbPool } from "../../../api/utils/db-pool";
import { invalidateEditSequenceCache } from "../qb-pipeline";

const LOG_PREFIX = "[QB-CONSOLIDATOR]";

/**
 * Timeout pass: pending rows stuck for >20 minutes are marked failed.
 * Covers cases where the async QB call threw before ever reaching 'submitted'
 * (e.g. bad query.graph fields, network error, bridge down).
 */
export async function runTimeoutPass(logger: any): Promise<void> {
  const pool = getDbPool();
  try {
    const { rows: timedOutRows, rowCount } = await pool.query(`
            UPDATE qb_order_pipeline
            SET    status     = 'failed',
                   updated_at = NOW(),
                   error      = 'Timed out in pending state (>20 min) — no response from QB bridge',
                   failed_at  = NOW()
            WHERE  status = 'pending'
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

/**
 * Stale submitted cleanup: rows stuck in 'submitted' for >30 minutes are
 * marked failed and their EditSequence cache is invalidated so stale sequences
 * aren't reused on the next retry.
 */
export async function runStaleSubmittedCleanup(logger: any): Promise<void> {
  const pool = getDbPool();
  try {
    const { rows: staleSubmitted } = await pool.query(
      `UPDATE qb_order_pipeline
             SET status = 'failed', error = 'Stale: no bridge confirmation after 30 minutes', updated_at = NOW(), failed_at = NOW(), confirmed_at = NULL
             WHERE status = 'submitted' AND updated_at < NOW() - INTERVAL '30 minutes'
             RETURNING id, step, qb_txn_id`
    );
    for (const row of staleSubmitted) {
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
 * Stale pending cleanup: rows stuck in 'pending' for >20 minutes are marked
 * failed with individual log entries (complements the timeout pass batch update).
 */
export async function runStalePendingCleanup(logger: any): Promise<void> {
  const pool = getDbPool();
  try {
    const { rows: stalePending } = await pool.query(
      `UPDATE qb_order_pipeline
             SET status = 'failed', error = 'Stale: never submitted within 20 minutes', updated_at = NOW(), failed_at = NOW(), confirmed_at = NULL
             WHERE status = 'pending' AND updated_at < NOW() - INTERVAL '20 minutes'
             RETURNING id, step`
    );
    for (const row of stalePending) {
      logger.warn(
        `${LOG_PREFIX} ⏱️ Marked stale pending row ${row.id} (step=${row.step}) as failed`
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
