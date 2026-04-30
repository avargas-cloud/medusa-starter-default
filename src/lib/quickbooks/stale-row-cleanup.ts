/**
 * Stale-row cleanup helper for QB pipeline tables.
 *
 * Why this exists:
 * - The qb-pipeline-consolidator already does timeout cleanup, but it runs less
 *   frequently than the per-entity pollers. If the consolidator is delayed or
 *   crashes, stale rows pile up.
 * - Calling this helper at the start of each poller's tick is a cheap safety net:
 *   any row stuck in `waiting`/`submitted`/`processing` past its threshold is
 *   demoted to `error` so the normal retry pipeline picks it up.
 *
 * Idempotent: calling repeatedly is safe — each call just affects whatever rows
 * are currently past their threshold.
 */
import type { Knex } from "knex";

export interface StaleStatusConfig {
  /** Status value to match in the WHERE clause (e.g. 'waiting', 'submitted'). */
  status: string;
  /** Demote to `error` after row hasn't been updated for this many minutes. */
  timeoutMin: number;
  /** If true, also clear `qb_operation_id` (used for `submitted` rows that lost the bridge op). */
  clearOpId?: boolean;
}

export interface StaleCleanupResult {
  /** Total rows marked as `error` across all configured statuses. */
  marked: number;
  /** Per-status breakdown. */
  byStatus: Record<string, number>;
}

/**
 * Marks pipeline rows that have been stuck longer than configured thresholds
 * as `error` so they re-enter the normal retry cycle.
 *
 * @param knex Medusa's knex instance (resolve from container)
 * @param table pipeline table name (e.g. 'qb_purchase_order_pipeline')
 * @param staleStatuses array of (status, timeout) pairs to clean
 * @param logger optional logger for warn-level reporting
 */
export async function markStaleRowsAsFailed(
  knex: Knex,
  table: string,
  staleStatuses: StaleStatusConfig[],
  logger?: { warn: (msg: string) => void }
): Promise<StaleCleanupResult> {
  const result: StaleCleanupResult = { marked: 0, byStatus: {} };

  for (const cfg of staleStatuses) {
    const setClauses: string[] = [
      `status = 'error'`,
      `last_error = ?`,
      `next_retry_at = NOW() + INTERVAL '2 minutes'`,
      `updated_at = NOW()`,
    ];
    if (cfg.clearOpId) {
      setClauses.splice(2, 0, `qb_operation_id = NULL`);
    }

    const errorMsg = `Timeout: row stuck in '${cfg.status}' > ${cfg.timeoutMin} min`;

    const res = await knex.raw(
      `UPDATE ${table}
       SET ${setClauses.join(", ")}
       WHERE status = ?
         AND updated_at < NOW() - INTERVAL '${cfg.timeoutMin} minutes'`,
      [errorMsg, cfg.status]
    );

    const rowCount: number = res.rowCount ?? 0;
    result.marked += rowCount;
    result.byStatus[cfg.status] = rowCount;

    if (rowCount > 0 && logger) {
      logger.warn(
        `[stale-cleanup] ${table}: ${rowCount} row(s) demoted from '${cfg.status}' (> ${cfg.timeoutMin} min) → 'error'`
      );
    }
  }

  return result;
}

/**
 * Standard config for QB pipelines that use the `waiting → submitted → synced` lifecycle.
 * Matches the consolidator's existing thresholds (20 min waiting, 30 min submitted).
 */
export const STANDARD_STALE_CONFIG: StaleStatusConfig[] = [
  { status: "waiting", timeoutMin: 20, clearOpId: false },
  { status: "submitted", timeoutMin: 30, clearOpId: true },
];

/**
 * Config for inventory-adjustment pipeline which uses `pending → processing → synced`
 * (note: uses 'processing' instead of 'submitted').
 */
export const INVENTORY_ADJUSTMENT_STALE_CONFIG: StaleStatusConfig[] = [
  { status: "waiting", timeoutMin: 20, clearOpId: false },
  { status: "processing", timeoutMin: 30, clearOpId: true },
];
