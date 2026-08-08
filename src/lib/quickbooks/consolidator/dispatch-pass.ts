import type { MedusaContainer } from "@medusajs/framework/types";

import { getDbPool } from "../../../api/utils/db-pool";
import type { ResubmitRow } from "./resubmit-by-step";
import { resubmitByStep } from "./resubmit-by-step";
import {
  enqueuePurchaseQbOperation,
  purchaseOperationKey,
  type PurchaseDependencyKnex,
} from "../../purchase-orders/qb-purchase-dependency-chain";

const LOG_PREFIX = "[QB-CONSOLIDATOR]";

/**
 * Repairs the narrow crash window between writing the operator-facing PO row
 * and attaching its universal dependency row. These rows are explicitly
 * marked delegated, so the legacy poller will never send them directly.
 */
export async function runPurchaseDelegationRepairPass(
  container: MedusaContainer,
  logger: any
): Promise<void> {
  const knex = container.resolve(
    "__pg_connection__"
  ) as PurchaseDependencyKnex;
  const result = await knex.raw(
    `SELECT id, purchase_order_id, payload
       FROM qb_purchase_order_pipeline
      WHERE order_pipeline_id IS NULL
        AND deleted_at IS NULL
        AND status IN ('waiting', 'error')
        AND COALESCE(payload->>'is_mod', 'false') = 'true'
        AND COALESCE(
          payload->>'delegated_to_consolidator',
          'false'
        ) = 'true'
      ORDER BY updated_at ASC
      LIMIT 20`
  );
  for (const rawRow of result.rows) {
    const row = rawRow as {
      id: string;
      purchase_order_id: string;
      payload: Record<string, unknown>;
    };
    try {
      const payload: Record<string, unknown> = {
        ...row.payload,
        qb_purchase_order_pipeline_id: row.id,
      };
      const operation = await enqueuePurchaseQbOperation(knex, {
        purchaseOrderId: row.purchase_order_id,
        referenceId: row.purchase_order_id,
        referenceType: "purchase_order",
        step: "purchase_order_mod",
        qbTxnId:
          typeof payload.txn_id === "string" ? payload.txn_id : null,
        payload,
        operationKey: purchaseOperationKey(
          "purchase_order_mod",
          row.purchase_order_id,
          payload
        ),
      });
      await knex.raw(
        `UPDATE qb_purchase_order_pipeline
            SET order_pipeline_id = ?, status = 'waiting',
                last_error = NULL, next_retry_at = NULL,
                updated_at = NOW()
          WHERE id = ?`,
        [operation.id, row.id]
      );
      logger.warn(
        `${LOG_PREFIX} 🩹 Repaired missing dependency row for PO pipeline ${row.id}`
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      await knex.raw(
        `UPDATE qb_purchase_order_pipeline
            SET status = 'error', last_error = ?,
                next_retry_at = NOW() + INTERVAL '2 minutes',
                updated_at = NOW()
          WHERE id = ?`,
        [message, row.id]
      );
      logger.warn(
        `${LOG_PREFIX} ⚠️ Could not repair PO delegation ${row.id}: ${message}`
      );
    }
  }

  const receiptResult = await knex.raw(
    `SELECT id, purchase_order_id, purchase_order_receipt_id,
            status, payload, mod_status, mod_payload
       FROM qb_item_receipt_pipeline
      WHERE deleted_at IS NULL
        AND (
          (
            add_order_pipeline_id IS NULL
            AND status IN ('waiting', 'error')
            AND COALESCE(
              payload->>'delegated_to_consolidator',
              'false'
            ) = 'true'
          )
          OR (
            mod_order_pipeline_id IS NULL
            AND mod_status IN ('waiting', 'error')
            AND COALESCE(
              mod_payload->>'delegated_to_consolidator',
              'false'
            ) = 'true'
          )
        )
      ORDER BY updated_at ASC
      LIMIT 20`
  );
  for (const rawRow of receiptResult.rows) {
    const row = rawRow as {
      id: string;
      purchase_order_id: string;
      purchase_order_receipt_id: string;
      status: string | null;
      payload: Record<string, unknown> | null;
      mod_status: string | null;
      mod_payload: Record<string, unknown> | null;
    };
    try {
      if (
        !row.payload ||
        !["waiting", "error"].includes(String(row.status))
      ) {
        // Nothing to repair in the ADD lane.
      } else {
        const payload: Record<string, unknown> = {
          ...row.payload,
          qb_item_receipt_pipeline_id: row.id,
        };
        const operation = await enqueuePurchaseQbOperation(knex, {
          purchaseOrderId: row.purchase_order_id,
          referenceId: row.purchase_order_receipt_id,
          referenceType: "item_receipt",
          step: "item_receipt_add",
          payload,
          operationKey: purchaseOperationKey(
            "item_receipt_add",
            row.purchase_order_receipt_id,
            payload
          ),
        });
        await knex.raw(
          `UPDATE qb_item_receipt_pipeline
              SET add_order_pipeline_id = ?, status = 'waiting',
                  last_error = NULL, next_retry_at = NULL,
                  updated_at = NOW()
            WHERE id = ?`,
          [operation.id, row.id]
        );
        logger.warn(
          `${LOG_PREFIX} 🩹 Repaired missing ADD dependency for receipt pipeline ${row.id}`
        );
      }

      if (
        !row.mod_payload ||
        !["waiting", "error"].includes(String(row.mod_status))
      ) {
        continue;
      }
      const modPayload: Record<string, unknown> = {
        ...row.mod_payload,
        qb_item_receipt_pipeline_id: row.id,
      };
      const modOperation = await enqueuePurchaseQbOperation(knex, {
        purchaseOrderId: row.purchase_order_id,
        referenceId: row.purchase_order_receipt_id,
        referenceType: "item_receipt",
        step: "item_receipt_mod",
        qbTxnId:
          typeof modPayload.txn_id === "string"
            ? modPayload.txn_id
            : null,
        payload: modPayload,
        operationKey: purchaseOperationKey(
          "item_receipt_mod",
          row.purchase_order_receipt_id,
          modPayload
        ),
      });
      await knex.raw(
        `UPDATE qb_item_receipt_pipeline
            SET mod_order_pipeline_id = ?, mod_status = 'waiting',
                mod_last_error = NULL, mod_next_retry_at = NULL,
                updated_at = NOW()
          WHERE id = ?`,
        [modOperation.id, row.id]
      );
      logger.warn(
        `${LOG_PREFIX} 🩹 Repaired missing MOD dependency for receipt pipeline ${row.id}`
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      await knex.raw(
        `UPDATE qb_item_receipt_pipeline
            SET last_error = CASE
                  WHEN add_order_pipeline_id IS NULL THEN ?
                  ELSE last_error
                END,
                mod_last_error = CASE
                  WHEN mod_order_pipeline_id IS NULL THEN ?
                  ELSE mod_last_error
                END,
                updated_at = NOW()
          WHERE id = ?`,
        [message, message, row.id]
      );
      logger.warn(
        `${LOG_PREFIX} ⚠️ Could not repair receipt delegation ${row.id}: ${message}`
      );
    }
  }
}

/**
 * Pending dispatch pass: processes pending rows for steps that are enqueued
 * directly in 'pending' state and need an active push per tick.
 * Covers all main pipeline steps (estimate, sales_order, invoice, payment, etc.)
 * as well as management steps (estimate_cancel, credit_memo_mod, transfer_customer,
 * so_close, so_reopen) and void/cancel steps (void_sales_order, void_invoice, etc.).
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
         WHERE step IN ('estimate_cancel', 'estimate_deactivate', 'credit_memo_mod', 'transfer_customer', 'transfer_payment', 'payment_txndate_change', 'payment_method_change', 'refund_check_mod', 'refund_payment_txndate_change', 'refund_apply_del', 'estimate', 'estimate_mod', 'sales_order', 'sales_order_mod', 'so_close', 'so_reopen', 'sales_receipt', 'invoice', 'invoice_update', 'sales_receipt_update', 'credit_memo', 'void_credit_memo', 'void_invoice', 'void_sales_order', 'void_sales_receipt', 'void_check', 'void_payment', 'payment', 'apply_payment', 'inventory_adjustment', 'void_inventory_adjustment', 'purchase_order_mod', 'item_receipt_add', 'item_receipt_mod', 'vendor_bill_add', 'vendor_bill_mod', 'vendor_bill_rebuild_preflight', 'vendor_bill_rebuild_delete', 'vendor_bill_payment_check')
           AND (
             -- A 'pending' row is normally due immediately. It carries a
             -- next_retry_at only when a handler DEFERRED it on purpose
             -- (see deferPipelineRow: apply_payment waiting for a document to
             -- go quiescent). Honouring it here lets a deferral be expressed
             -- without the row masquerading as 'failed' in the UI badges.
             (status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= NOW()))
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
       RETURNING p.id, p.order_id, p.reference_id, p.reference_type, p.step, p.qb_txn_id, p.retry_count, p.payload
    `);
    if (pendingMutations.length > 0) {
      logger.info(
        `${LOG_PREFIX} Processing ${pendingMutations.length} pending estimate_cancel/credit_memo_mod row(s)...`
      );
      // Parallel dispatch: a stuck handler on one row no longer blocks the rest
      // of the batch. With bridgeFetch's 60s timeout, the worst-case tick is
      // bounded regardless of batch size. Use allSettled so a thrown handler
      // doesn't reject the whole pass.
      const results = await Promise.allSettled(
        pendingMutations.map((r) =>
          resubmitByStep(r as ResubmitRow, container, logger)
        )
      );
      const failed = results.filter((r) => r.status === "rejected");
      if (failed.length > 0) {
        logger.warn(
          `${LOG_PREFIX} ⚠️ ${failed.length}/${pendingMutations.length} dispatch handlers threw — see individual handler logs`
        );
      }
    }
  } catch (mutPassErr: unknown) {
    const msg =
      mutPassErr instanceof Error ? mutPassErr.message : String(mutPassErr);
    logger.warn(`${LOG_PREFIX} ⚠️ pending mutations pass error: ${msg}`);
  }
}

/**
 * Wake dependents pass: any 'waiting' row whose depends_on row is now resolved
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
          AND d.status     IN ('confirmed', 'fixed')
        RETURNING w.id, w.order_id, w.reference_id, w.reference_type, w.step,
                  w.qb_txn_id, w.retry_count, w.payload`
    );
    if (awakenedRows.length > 0) {
      logger.info(
        `${LOG_PREFIX} ⏯️ Woke ${awakenedRows.length} waiting row(s) whose dependencies confirmed`
      );
      // Parallel dispatch (see runPendingDispatchPass for rationale).
      const results = await Promise.allSettled(
        awakenedRows.map((r) =>
          resubmitByStep(
            {
              id: r.id,
              order_id: r.order_id,
              reference_id: r.reference_id,
              reference_type: r.reference_type,
              step: r.step,
              qb_txn_id: r.qb_txn_id,
              retry_count: r.retry_count,
              payload: r.payload,
            } as ResubmitRow,
            container,
            logger
          )
        )
      );
      const failed = results.filter((r) => r.status === "rejected");
      if (failed.length > 0) {
        logger.warn(
          `${LOG_PREFIX} ⚠️ ${failed.length}/${awakenedRows.length} wake handlers threw — see individual handler logs`
        );
      }
    }
  } catch (wakeErr: unknown) {
    const msg = wakeErr instanceof Error ? wakeErr.message : String(wakeErr);
    logger.warn(`${LOG_PREFIX} ⚠️ Wake-dependents pass error: ${msg}`);
  }
}

/**
 * Keeps terminal dependency failures visible without dispatching the child.
 * The child remains `waiting`, so retrying/fixing the parent can still wake it.
 */
export async function runBlockedDependentsPass(logger: any): Promise<void> {
  const pool = getDbPool();
  try {
    const { rows } = await pool.query(
      `UPDATE qb_order_pipeline child
          SET error = 'Blocked by ' || parent.status || ' dependency ' ||
                      parent.id::text || ' (' || parent.step || ')',
              updated_at = NOW()
         FROM qb_order_pipeline parent
        WHERE child.depends_on = parent.id
          AND child.status = 'waiting'
          AND parent.status IN ('failed', 'skipped')
          AND parent.next_retry_at IS NULL
          AND child.error IS DISTINCT FROM
              ('Blocked by ' || parent.status || ' dependency ' ||
               parent.id::text || ' (' || parent.step || ')')
        RETURNING child.id, child.step, parent.id AS parent_id,
                  parent.status AS parent_status`
    );
    for (const row of rows) {
      logger.warn(
        `${LOG_PREFIX} ⛔ ${row.step} row ${row.id} remains waiting: dependency ${row.parent_id} is ${row.parent_status}`
      );
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      `${LOG_PREFIX} ⚠️ Blocked-dependents pass error: ${message}`
    );
  }
}

/**
 * Orphaned-waiting rescue pass: a 'payment' row written as 'waiting' with NO depends_on
 * can never be recovered by either other pass — runWakeDependentsPass requires
 * depends_on→confirmed (its JOIN never matches a NULL), and runPendingDispatchPass only
 * claims 'pending'. Such a row is the residue of a lost in-process dispatch (e.g. a
 * fire-and-forget setTimeout killed by a process restart). Once it is older than the
 * grace window — long past any legitimate in-flight timer — promote it to 'pending' so
 * the dispatch pass picks it up on the next tick.
 *
 * Scoped to step='payment' on purpose: handlePosPaymentCreated is fully idempotent and
 * guards every skip case (already-synced, SR-embedded, $0 anchor, refund), so promoting
 * is always safe. Other steps that park as 'waiting' (invoice/sales_receipt placeholders)
 * have their own promotion path in qb-pos-sync and must not be force-dispatched here.
 */
export async function runOrphanedWaitingPass(logger: any): Promise<void> {
  const pool = getDbPool();
  try {
    const { rows: promoted } = await pool.query(
      `UPDATE qb_order_pipeline
          SET status     = 'pending',
              updated_at = NOW(),
              error      = NULL
        WHERE status      = 'waiting'
          AND depends_on  IS NULL
          AND step        = 'payment'
          AND created_at  < NOW() - INTERVAL '3 minutes'
          -- $0 payments have nothing to record in QB. Promoting one costs a
          -- pointless dispatch round-trip, and if the handler's $0 guard ever
          -- stops settling the row it loops forever (PAY-3230, 2026-07-23).
          -- Cheaper and safer to never wake it in the first place.
          AND NOT EXISTS (
                SELECT 1 FROM customer_payment cp
                 WHERE cp.id = qb_order_pipeline.reference_id
                   AND cp.amount = 0
              )
        RETURNING id, reference_id`
    );
    if (promoted.length > 0) {
      logger.info(
        `${LOG_PREFIX} 🩹 Promoted ${promoted.length} orphaned waiting payment row(s) to pending`
      );
    }
  } catch (orphanErr: unknown) {
    const msg =
      orphanErr instanceof Error ? orphanErr.message : String(orphanErr);
    logger.warn(`${LOG_PREFIX} ⚠️ Orphaned-waiting pass error: ${msg}`);
  }
}
