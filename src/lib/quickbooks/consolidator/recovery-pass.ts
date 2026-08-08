import { getDbPool } from "../../../api/utils/db-pool";
import {
  closeSalesOrderInQb,
  reopenSalesOrderInQb,
} from "../client/sales-orders";
import { activateRefundPaymentRow } from "./refund-payment-activation";

const LOG_PREFIX = "[QB-CONSOLIDATOR]";

/**
 * Steps whose re-dispatch is IDEMPOTENT in QuickBooks — MOD / VOID / toggle /
 * cancel / deactivate. Re-running them re-fetches the current EditSequence or
 * re-applies a no-op-safe change, so a duplicate QB document is impossible.
 * ADD steps (estimate, sales_order, sales_receipt, invoice, credit_memo,
 * payment, apply_payment, inventory_adjustment) are intentionally NOT here: a
 * blind re-submit could create a duplicate QB document if the original bridge
 * op was created just before a crash. Those stay on the conservative 20-minute
 * runTimeoutPass (dup-safe fast recovery for ADDs needs a bridge idempotency
 * ledger — future work).
 */
const IDEMPOTENT_REDISPATCH_STEPS = [
  "invoice_update",
  "sales_receipt_update",
  "credit_memo_mod",
  "estimate_mod",
  "sales_order_mod",
  "estimate_cancel",
  "estimate_deactivate",
  "so_close",
  "so_reopen",
  "transfer_customer",
  "payment_method_change",
  "void_invoice",
  "void_sales_receipt",
  "void_sales_order",
  "void_credit_memo",
  "void_check",
  // TxnDel de un ReceivePayment: borrar dos veces da error, nunca duplica.
  "void_payment",
  "refund_apply_del",
  "void_inventory_adjustment",
  "purchase_order_mod",
  "item_receipt_mod",
  "vendor_bill_mod",
  "vendor_bill_rebuild_preflight",
  "vendor_bill_rebuild_delete",
];

/**
 * Orphaned-processing recovery (Workstream B2).
 *
 * A 'processing' row with NO bridge_op_id was claimed by dispatch but never
 * reached 'submitted' — typically a server reset mid-dispatch (e.g. a Railway
 * deploy) killed the worker. runTimeoutPass eventually rescues these, but only
 * after 20 minutes. This recovers IDEMPOTENT steps faster (>8 min) by resetting
 * them to 'pending' so the next dispatch re-claims them.
 *
 * The 8-minute threshold is deliberately above the worst-case MOD snapshot-fetch
 * poll (~6.7 min = POLL_INTERVAL_MS 20s × MAX_POLL_ATTEMPTS 20) so a LIVE MOD
 * still polling its EditSequence is never reset out from under itself. Capped at
 * retry_count < 5 to avoid loops.
 */
export async function runOrphanedProcessingRecovery(
  logger: any
): Promise<void> {
  const pool = getDbPool();
  try {
    const { rows, rowCount } = await pool.query(
      `UPDATE qb_order_pipeline
          SET status        = 'pending',
              bridge_op_id  = NULL,
              error         = NULL,
              retry_count   = COALESCE(retry_count, 0) + 1,
              next_retry_at = NOW(),
              updated_at    = NOW()
        WHERE status = 'processing'
          AND bridge_op_id IS NULL
          AND step = ANY($1::text[])
          AND COALESCE(updated_at, created_at) < NOW() - INTERVAL '8 minutes'
          AND COALESCE(retry_count, 0) < 5
        RETURNING id, step, order_id`,
      [IDEMPOTENT_REDISPATCH_STEPS]
    );
    if (rowCount && rowCount > 0) {
      for (const r of rows) {
        logger.info(
          `${LOG_PREFIX} 🔄 Orphan recovery: re-queued processing ${r.step} row ${r.id} (order ${r.order_id}) — idempotent step, no bridge_op_id, >8min`
        );
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      `${LOG_PREFIX} ⚠️ Orphaned-processing recovery error: ${msg}`
    );
  }
}

/**
 * Recovery pass for refund_payment rows whose depends_on write_check is
 * already confirmed. Claims two shapes:
 *  - 'waiting' rows orphaned mid-confirmation (server restarted before the
 *    write_check-confirm path could activate them), and
 *  - 'failed' rows with a due next_retry_at — refund_payment is NOT in the
 *    pending-dispatch step list, so timeout-pass casualties (bridge outage)
 *    had no retry path and stayed failed forever (Refund PAY-3179, 2026-07-22).
 * Activation itself lives in activateRefundPaymentRow (shared with
 * poll-submitted-rows); the bridge call is idempotency-keyed, so a retry after
 * a lost response cannot mint a duplicate $0 ReceivePayment.
 */
export async function runRefundPaymentRecovery(logger: any): Promise<void> {
  const pool = getDbPool();
  try {
    const { rows: orphanRows } = await pool.query(`
            SELECT rp.id, rp.reference_id, rp.payload, rp.status, rp.retry_count,
                   wc.qb_txn_id AS check_txn_id
            FROM qb_order_pipeline rp
            JOIN qb_order_pipeline wc ON wc.id = rp.depends_on
            WHERE rp.step   = 'refund_payment'
              AND wc.step   = 'write_check'
              AND wc.status = 'confirmed'
              AND wc.qb_txn_id IS NOT NULL
              AND (
                rp.status = 'waiting'
                OR (rp.status = 'failed'
                    AND rp.next_retry_at IS NOT NULL
                    AND rp.next_retry_at <= NOW()
                    AND COALESCE(rp.retry_count, 0) < 8)
              )
        `);

    if (orphanRows.length > 0) {
      logger.info(
        `${LOG_PREFIX} 🔄 Recovery: found ${orphanRows.length} refund_payment row(s) to activate`
      );
    }

    for (const rpRow of orphanRows) {
      try {
        await activateRefundPaymentRow(
          pool,
          logger,
          rpRow,
          rpRow.check_txn_id as string,
          "Recovery: "
        );
      } catch (recErr: unknown) {
        const msg = recErr instanceof Error ? recErr.message : String(recErr);
        if (rpRow.status === "failed") {
          // Bridge unreachable on a retry attempt — reschedule with a growing
          // backoff instead of stranding the row (attempt cap enforced by the
          // claim query above). 'waiting' rows keep their status: the next
          // consolidator tick re-claims them for free.
          const attempt = Number(rpRow.retry_count ?? 0) + 1;
          try {
            await pool.query(
              `UPDATE qb_order_pipeline
                  SET retry_count   = $2,
                      error         = $3,
                      next_retry_at = NOW() + (LEAST($2 * 2, 30) || ' minutes')::interval,
                      updated_at    = NOW()
                WHERE id = $1 AND status = 'failed'`,
              [rpRow.id, attempt, msg]
            );
          } catch {
            // non-fatal — the row keeps its previous next_retry_at
          }
        }
        logger.warn(
          `${LOG_PREFIX} ⚠️ Recovery: failed to activate ${rpRow.id}: ${msg}`
        );
      }
    }
  } catch (recoveryErr: unknown) {
    const msg =
      recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr);
    logger.warn(`${LOG_PREFIX} ⚠️ Recovery pass error: ${msg}`);
  }
}

/**
 * Recovery pass: orphaned waiting so_close/so_reopen rows whose parent row is
 * already confirmed (e.g. server restarted mid-confirmation).
 * Re-fires the close/reopen QB call and marks the row submitted.
 */
export async function runSoToggleRecovery(logger: any): Promise<void> {
  const pool = getDbPool();
  try {
    const { rows: orphanSoRows } = await pool.query(`
            SELECT child.id, child.step, child.order_id
            FROM qb_order_pipeline child
            JOIN qb_order_pipeline parent ON parent.id = child.depends_on
            WHERE child.step   IN ('so_close', 'so_reopen')
              AND child.status  = 'waiting'
              AND parent.step  IN ('so_close', 'so_reopen')
              AND parent.status = 'confirmed'
        `);

    if (orphanSoRows.length > 0) {
      logger.info(
        `${LOG_PREFIX} 🔄 Recovery: found ${orphanSoRows.length} orphaned so_close/so_reopen row(s)`
      );
    }

    for (const soRow of orphanSoRows) {
      try {
        const { rows: orderRows } = await pool.query(
          `SELECT metadata FROM "order" WHERE id = $1`,
          [soRow.order_id]
        );
        const soMeta = orderRows[0]?.metadata || {};
        const soTxnId: string | undefined =
          (soMeta.qb_sales_order as Record<string, unknown>)?.txn_id as
            | string
            | undefined ||
          soMeta.qb_so_txn_id ||
          soMeta.qb_sales_order_txn_id;
        if (!soTxnId) {
          logger.warn(
            `${LOG_PREFIX} ⚠️ Recovery: no soTxnId for ${soRow.step} ${soRow.id} — skipping`
          );
          continue;
        }
        const soResult =
          soRow.step === "so_close"
            ? await closeSalesOrderInQb(soTxnId, (m: string) => logger.info(m))
            : await reopenSalesOrderInQb(soTxnId, (m: string) =>
                logger.info(m)
              );
        if (soResult.success && soResult.data?.operationId) {
          await pool.query(
            `UPDATE qb_order_pipeline
                         SET status = 'submitted', bridge_op_id = $2, submitted_at = NOW()
                         WHERE id = $1`,
            [soRow.id, soResult.data.operationId]
          );
          logger.info(
            `${LOG_PREFIX} ✅ Recovery: ${soRow.step} ${soRow.id} activated → op ${soResult.data.operationId}`
          );
        } else {
          await pool.query(
            `UPDATE qb_order_pipeline SET status = 'failed', error = $2, failed_at = NOW() WHERE id = $1`,
            [soRow.id, soResult.error ?? "QB sync failed (recovery)"]
          );
          logger.warn(
            `${LOG_PREFIX} ⚠️ Recovery: failed to activate ${soRow.step} ${soRow.id}: ${soResult.error}`
          );
        }
      } catch (soRecErr: unknown) {
        const msg =
          soRecErr instanceof Error ? soRecErr.message : String(soRecErr);
        logger.warn(
          `${LOG_PREFIX} ⚠️ Recovery: error activating ${soRow.step} ${soRow.id}: ${msg}`
        );
      }
    }
  } catch (soRecoveryErr: unknown) {
    const msg =
      soRecoveryErr instanceof Error
        ? soRecoveryErr.message
        : String(soRecoveryErr);
    logger.warn(`${LOG_PREFIX} ⚠️ SO recovery pass error: ${msg}`);
  }
}
