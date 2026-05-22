import { getDbPool } from "../../../api/utils/db-pool";
import { writePipelineRow } from "./row-mutations";

/**
 * After an order's Sales Order is confirmed in QuickBooks, deactivate the
 * Estimate it was "converted" from (sets IsActive=false via a retryable
 * estimate_deactivate pipeline step).
 *
 * Why: QBXML SalesOrderAdd has no LinkToTxnID (verified — it was removed from
 * this codebase in Feb 2026 as "not supported by QBXML schema"), so the SO is
 * rebuilt from scratch and the source Estimate lingers in QB's "Open Estimates"
 * list. Marking it inactive drops it off that list while PRESERVING line amounts
 * (deactivate, not cancel/zero-out) so the historical estimate stays intact.
 *
 * Idempotent: only enqueues when a 'confirmed' estimate with a qb_txn_id exists
 * for the order AND no estimate_deactivate row is already active/done for it.
 *
 * Returns the enqueued pipeline row id, or null when nothing was enqueued
 * (no estimate to close, or a deactivate row already exists).
 */
export async function enqueueEstimateDeactivateIfNeeded(
  orderId: string,
  log?: (msg: string) => void
): Promise<string | null> {
  const pool = getDbPool();

  const { rows: estRows } = await pool.query(
    `SELECT qb_txn_id, qb_ref_number, medusa_ref_number
       FROM qb_order_pipeline
      WHERE order_id = $1
        AND step = 'estimate'
        AND status = 'confirmed'
        AND qb_txn_id IS NOT NULL
      LIMIT 1`,
    [orderId]
  );
  const est = estRows[0];
  if (!est?.qb_txn_id) return null;

  const { rows: alreadyEnqueued } = await pool.query(
    `SELECT 1 FROM qb_order_pipeline
      WHERE order_id = $1
        AND step = 'estimate_deactivate'
        AND status IN ('pending', 'processing', 'submitted', 'confirmed')
      LIMIT 1`,
    [orderId]
  );
  if (alreadyEnqueued.length > 0) return null;

  const rowId = await writePipelineRow({
    orderId,
    step: "estimate_deactivate",
    status: "pending",
    qbTxnId: est.qb_txn_id,
    qbRefNumber: est.qb_ref_number ?? null,
    medusaRefNumber: est.medusa_ref_number ?? null,
  });

  log?.(
    `📥 Enqueued estimate_deactivate for estimate ${est.qb_txn_id} (order ${orderId} — SO confirmed)`
  );
  return rowId;
}
