import { getDbPool } from "../../../api/utils/db-pool";
import { bridgeFetch } from "../client/core";
import {
  closeSalesOrderInQb,
  reopenSalesOrderInQb,
} from "../client/sales-orders";

const LOG_PREFIX = "[QB-CONSOLIDATOR]";

/**
 * Recovery pass: orphaned waiting refund_payment rows whose depends_on
 * write_check is already confirmed (e.g. server restarted mid-confirmation).
 * Re-enqueues the receive-payment bridge call and marks the row submitted.
 */
export async function runRefundPaymentRecovery(logger: any): Promise<void> {
  const pool = getDbPool();
  try {
    const { rows: orphanRows } = await pool.query(`
            SELECT rp.id, rp.reference_id, rp.payload, wc.qb_txn_id AS check_txn_id
            FROM qb_order_pipeline rp
            JOIN qb_order_pipeline wc ON wc.id = rp.depends_on
            WHERE rp.step   = 'refund_payment'
              AND rp.status = 'waiting'
              AND wc.step   = 'write_check'
              AND wc.status = 'confirmed'
              AND wc.qb_txn_id IS NOT NULL
        `);

    if (orphanRows.length > 0) {
      logger.info(
        `${LOG_PREFIX} 🔄 Recovery: found ${orphanRows.length} orphaned refund_payment row(s) to activate`
      );
    }

    for (const rpRow of orphanRows) {
      try {
        const checkTxnId: string = rpRow.check_txn_id;
        const rpPayload = rpRow.payload ?? {};

        const { rows: cpRows } = await pool.query(
          `SELECT cp.reference, cp.amount, cp.metadata,
                            cust.metadata->>'qb_list_id' AS customer_list_id
                     FROM customer_payment cp
                     JOIN customer cust ON cust.id = cp.customer_id
                     WHERE cp.id = $1`,
          [rpRow.reference_id]
        );
        const cp = cpRows[0];
        if (!cp?.customer_list_id) {
          logger.warn(
            `${LOG_PREFIX} ⚠️ Recovery: no customer QB ListID for refund_payment ${rpRow.id}`
          );
          continue;
        }

        let creditTxnId: string | null = null;
        if (rpPayload.type === "credit_memo") {
          const { rows: cmRows } = await pool.query(
            `SELECT qb_txn_id FROM pos_credit_memo WHERE credit_memo_number = $1`,
            [cp.reference]
          );
          creditTxnId = cmRows[0]?.qb_txn_id ?? null;
          if (!creditTxnId) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Recovery: no QB TxnID for credit memo ${cp.reference} — skipping ${rpRow.id}`
            );
            continue;
          }
        } else {
          creditTxnId =
            rpPayload.originalPaymentTxnId ?? cp.metadata?.qb_txn_id ?? null;
          if (!creditTxnId) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Recovery: no original payment TxnID for refund_payment ${rpRow.id} — skipping`
            );
            continue;
          }
        }

        const refundAmount = cp.metadata?.refund_amount
          ? Number(cp.metadata.refund_amount)
          : Number(cp.amount);
        const amountDollars = Number(refundAmount / 100).toFixed(2);

        const rpRes = await bridgeFetch("POST", "/api/sync/enqueue", {
          type: "receive-payment",
          action: "add",
          data: {
            customerId: cp.customer_list_id,
            invoiceId: checkTxnId,
            creditTxnId: creditTxnId,
            amount: Number(amountDollars),
            totalAmount: 0,
            paymentAmount: 0,
          },
        });
        if (!rpRes?.operation_id) {
          logger.warn(
            `${LOG_PREFIX} ⚠️ Recovery: bridge did not return operation_id for ${rpRow.id}`
          );
          continue;
        }
        await pool.query(
          `UPDATE qb_order_pipeline
                     SET status = 'submitted', bridge_op_id = $2, submitted_at = NOW()
                     WHERE id = $1`,
          [rpRow.id, rpRes.operation_id]
        );
        logger.info(
          `${LOG_PREFIX} ✅ Recovery: refund_payment ${rpRow.id} activated (${rpPayload.type ?? "direct"}) → bridge op ${rpRes.operation_id}`
        );
      } catch (recErr: unknown) {
        const msg = recErr instanceof Error ? recErr.message : String(recErr);
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
