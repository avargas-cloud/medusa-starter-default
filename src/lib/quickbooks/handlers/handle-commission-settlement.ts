/**
 * Commissions Pipeline — dispatch de los dos steps del caso store_credit
 * (docs/ORDER_COMMISSIONS_PLAN.md §11.2, delta v2).
 *
 * `commission_check`   → CheckAdd: Dr gasto comisión / Cr clearing, payee = vendor.
 * `commission_payment` → ReceivePaymentAdd sin aplicar, DepositTo = clearing.
 *
 * Ambos son ADDs NO idempotentes: la Idempotency-Key es 1:1 con la FILA
 * (`commission-check:<rowId>` / `commission-payment:<rowId>`) — un reintento de
 * la misma fila reusa la key y el bridge dedupea; una emisión legítima nueva
 * exige fila nueva ⇒ key nueva (la lección del write_check de refunds).
 *
 * La ruta de settle solo escribe las filas; ESTE módulo es el único que toca el
 * bridge, invocado por el consolidator (resubmit-by-step). El payment nace
 * `waiting` con depends_on del check: despierta recién cuando el check confirmó.
 */

import { bridgeFetch } from "../client/core";
import { receivePaymentInQb } from "../client/payments";
import { failOrRetryPipelineRow, failPipelineRow } from "../pipeline/row-mutations";
import { getDbPool } from "../../../api/utils/db-pool";

export interface CommissionPipelineRow {
  id: string;
  reference_id: string | null;
  step: string;
  payload: Record<string, unknown> | null;
  retry_count?: number | null;
}

const LOG = "[commission-pipeline]";

async function markSubmitted(rowId: string, operationId: string): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `UPDATE qb_order_pipeline
        SET status = 'submitted', bridge_op_id = $2, updated_at = NOW(), error = NULL
      WHERE id = $1`,
    [rowId, operationId]
  );
}

async function markSettlementWaiting(settlementId: string): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `UPDATE commission_settlement
        SET status = 'qb_waiting', updated_at = NOW()
      WHERE id = $1 AND status = 'pending'`,
    [settlementId]
  );
}

export async function dispatchCommissionCheck(
  row: CommissionPipelineRow,
  logger: { info: (m: string) => void; warn: (m: string) => void }
): Promise<void> {
  const p = (row.payload ?? {}) as Record<string, string | undefined>;
  const required = [
    "settlementId",
    "amountDollars",
    "vendorListId",
    "clearingListId",
    "expenseListId",
    "refNumber",
    "txnDate",
  ] as const;
  for (const key of required) {
    if (!p[key]) {
      await failPipelineRow(row.id, `commission_check payload missing ${key}`);
      return;
    }
  }

  try {
    const enqueueRes = (await bridgeFetch(
      "POST",
      "/api/sync/enqueue",
      {
        type: "check",
        action: "add",
        data: {
          AccountRef: { ListID: p.clearingListId },
          PayeeEntityRef: { ListID: p.vendorListId },
          RefNumber: p.refNumber,
          TxnDate: p.txnDate,
          Memo: p.memo ?? "",
          ExpenseLineAdd: [
            {
              AccountRef: { ListID: p.expenseListId },
              Amount: p.amountDollars,
              Memo: p.memo ?? "",
            },
          ],
        },
      },
      { idempotencyKey: `commission-check:${row.id}` }
    )) as { operation_id?: string; operationId?: string } | undefined;

    const operationId = enqueueRes?.operation_id ?? enqueueRes?.operationId;
    if (!operationId) {
      await failOrRetryPipelineRow(
        row.id,
        "Bridge did not return operation_id for commission check",
        row.retry_count ?? 0
      );
      return;
    }
    await markSubmitted(row.id, operationId);
    await markSettlementWaiting(String(p.settlementId));
    logger.info(`${LOG} ✅ commission_check ${row.id} submitted op=${operationId} ref=${p.refNumber}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // El enqueue no llegó al bridge (transporte): la misma fila reintenta con la
    // MISMA key, así que un outcome ambiguo no puede duplicar el cheque.
    await failOrRetryPipelineRow(
      row.id,
      `commission_check enqueue failed: ${message}`,
      row.retry_count ?? 0
    );
    logger.warn(`${LOG} ⚠️ commission_check ${row.id} enqueue failed: ${message}`);
  }
}

export async function dispatchCommissionPayment(
  row: CommissionPipelineRow,
  logger: { info: (m: string) => void; warn: (m: string) => void }
): Promise<void> {
  const p = (row.payload ?? {}) as Record<string, string | undefined>;
  const required = [
    "settlementId",
    "amountDollars",
    "customerListId",
    "customerPaymentId",
    "depositAccountFullName",
    "txnDate",
  ] as const;
  for (const key of required) {
    if (!p[key]) {
      await failPipelineRow(row.id, `commission_payment payload missing ${key}`);
      return;
    }
  }

  const result = await receivePaymentInQb(
    {
      customerId: String(p.customerListId),
      amount: String(p.amountDollars),
      date: p.txnDate,
      paymentMethod: "Cash",
      memo: p.memo ?? "",
      autoApply: false,
      depositAccount: String(p.depositAccountFullName),
    },
    { idempotencyKey: `commission-payment:${row.id}` }
  );

  if (!result.success || !result.data?.operationId) {
    await failOrRetryPipelineRow(
      row.id,
      `commission_payment enqueue failed: ${result.success ? "no operationId" : result.error}`,
      row.retry_count ?? 0
    );
    logger.warn(`${LOG} ⚠️ commission_payment ${row.id} enqueue failed`);
    return;
  }
  await markSubmitted(row.id, result.data.operationId);
  logger.info(
    `${LOG} ✅ commission_payment ${row.id} submitted op=${result.data.operationId} cpay=${p.customerPaymentId}`
  );
}
