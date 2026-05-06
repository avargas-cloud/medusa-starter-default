import type { MedusaContainer } from "@medusajs/framework/types";

import { getDbPool } from "../../../api/utils/db-pool";
import type { ResubmitRow } from "./resubmit-by-step";
import { resubmitByStep } from "./resubmit-by-step";

const LOG_PREFIX = "[QB-CONSOLIDATOR]";

/**
 * Pending dispatch pass: processes pending rows for steps that are enqueued
 * directly in 'pending' state and need an active push per tick.
 * Covers all main pipeline steps (estimate, sales_order, invoice, payment, etc.)
 * as well as management steps (estimate_cancel, credit_memo_mod, transfer_customer,
 * so_close, so_reopen).
 */
export async function runPendingDispatchPass(
  container: MedusaContainer,
  logger: any
): Promise<void> {
  const pool = getDbPool();
  try {
    const { rows: pendingMutations } = await pool.query(`
      WITH claim AS (
        SELECT id
          FROM qb_order_pipeline
         WHERE step IN ('estimate_cancel', 'credit_memo_mod', 'transfer_customer', 'estimate', 'sales_order', 'so_close', 'so_reopen', 'sales_receipt', 'invoice', 'invoice_update', 'sales_receipt_update', 'credit_memo', 'void_credit_memo', 'void_invoice', 'void_sales_receipt', 'void_check', 'payment', 'apply_payment')
           AND (
             status = 'pending'
             OR (status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= NOW())
           )
         ORDER BY COALESCE(updated_at, created_at) ASC
         LIMIT 20
         FOR UPDATE SKIP LOCKED
      )
      UPDATE qb_order_pipeline p
         SET status = 'processing',
             updated_at = NOW(),
             error = NULL
        FROM claim
       WHERE p.id = claim.id
       RETURNING p.id, p.order_id, p.reference_id, p.reference_type, p.step, p.qb_txn_id
    `);
    if (pendingMutations.length > 0) {
      logger.info(
        `${LOG_PREFIX} Processing ${pendingMutations.length} pending estimate_cancel/credit_memo_mod row(s)...`
      );
      for (const r of pendingMutations) {
        await resubmitByStep(r as ResubmitRow, container, logger);
      }
    }
  } catch (mutPassErr: unknown) {
    const msg =
      mutPassErr instanceof Error ? mutPassErr.message : String(mutPassErr);
    logger.warn(`${LOG_PREFIX} ⚠️ pending mutations pass error: ${msg}`);
  }
}

/**
 * Wake dependents pass: any 'waiting' row whose depends_on row is now 'confirmed'
 * is claimed as 'processing' AND immediately dispatched via resubmitByStep.
 * Typical case: a document was blocked on customer creation; once the customer
 * confirms, the dependent document auto-resubmits with no user intervention.
 */
export async function runWakeDependentsPass(
  container: MedusaContainer,
  logger: any
): Promise<void> {
  const pool = getDbPool();
  try {
    const { rows: awakenedRows } = await pool.query(
      `UPDATE qb_order_pipeline w
          SET status       = 'processing',
              updated_at   = NOW(),
              error        = NULL,
              failed_at    = NULL,
              submitted_at = NULL,
              bridge_op_id = NULL
         FROM qb_order_pipeline d
        WHERE w.depends_on = d.id
          AND w.status     = 'waiting'
          AND d.status     = 'confirmed'
        RETURNING w.id, w.order_id, w.reference_id, w.reference_type, w.step, w.qb_txn_id`
    );
    if (awakenedRows.length > 0) {
      logger.info(
        `${LOG_PREFIX} ⏯️ Woke ${awakenedRows.length} waiting row(s) whose dependencies confirmed`
      );
      for (const r of awakenedRows) {
        await resubmitByStep(
          {
            id: r.id,
            order_id: r.order_id,
            reference_id: r.reference_id,
            reference_type: r.reference_type,
            step: r.step,
            qb_txn_id: r.qb_txn_id,
          } as ResubmitRow,
          container,
          logger
        );
      }
    }
  } catch (wakeErr: unknown) {
    const msg = wakeErr instanceof Error ? wakeErr.message : String(wakeErr);
    logger.warn(`${LOG_PREFIX} ⚠️ Wake-dependents pass error: ${msg}`);
  }
}
