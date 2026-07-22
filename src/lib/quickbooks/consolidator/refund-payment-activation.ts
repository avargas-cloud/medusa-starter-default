import { bridgeFetch } from "../client/core";

const LOG_PREFIX = "[QB-CONSOLIDATOR]";

export interface RefundPaymentRowLite {
  id: string;
  reference_id: string; // customer_payment id
  payload: Record<string, unknown> | null;
}

type PgPoolLike = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
};

/**
 * Enqueue the $0 ReceivePayment (SetCredit apply) that closes the open A/R
 * from a refund's Write Check, and mark the refund_payment row submitted.
 *
 * Shared by the write_check-confirm path (poll-submitted-rows) and the
 * recovery pass — the logic used to live copy-pasted in both and had started
 * to drift. Single source now.
 *
 * The bridge call carries an Idempotency-Key (`refund-payment:<cpay_id>`), so
 * a retry after a lost response can never mint a duplicate $0 ReceivePayment —
 * the bridge ADD-dedupe ledger returns the in-flight/completed op instead.
 *
 * Returns true when the row was marked submitted; false on a permanent
 * skip-condition (missing customer ListID / credit TxnID). Throws on bridge
 * errors so callers can schedule a retry.
 */
export async function activateRefundPaymentRow(
  pool: PgPoolLike,
  logger: any,
  rpRow: RefundPaymentRowLite,
  checkTxnId: string,
  logLabel: string = ""
): Promise<boolean> {
  const rpPayload = (rpRow.payload ?? {}) as Record<string, any>;

  const { rows: cpRows } = await pool.query(
    `SELECT cp.reference, cp.amount, cp.metadata,
            cp.batch_day,
            cust.metadata->>'qb_list_id' AS customer_list_id
     FROM customer_payment cp
     JOIN customer cust ON cust.id = cp.customer_id
     WHERE cp.id = $1`,
    [rpRow.reference_id]
  );
  const cp = cpRows[0];
  if (!cp?.customer_list_id) {
    logger.warn(
      `${LOG_PREFIX} ⚠️ ${logLabel}No customer QB ListID for refund_payment ${rpRow.id}`
    );
    return false;
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
        `${LOG_PREFIX} ⚠️ ${logLabel}No QB TxnID for credit memo ${cp.reference} — refund_payment ${rpRow.id} skipped`
      );
      return false;
    }
  } else {
    creditTxnId = rpPayload.originalPaymentTxnId ?? cp.metadata?.qb_txn_id ?? null;
    if (!creditTxnId) {
      logger.warn(
        `${LOG_PREFIX} ⚠️ ${logLabel}No original ReceivePayment TxnID for refund_payment ${rpRow.id} — skipping`
      );
      return false;
    }
  }

  const refundAmount = cp.metadata?.refund_amount
    ? Number(cp.metadata.refund_amount)
    : Number(cp.amount);
  const amountDollars = Number(refundAmount / 100).toFixed(2);

  // Explicit TxnDate (durable rule: EVERY ReceivePayment callsite sends one) —
  // refund date from payload, batch_day fallback for legacy rows.
  const rpTxnDate =
    (rpPayload.txnDate as string | undefined) ??
    (cp.batch_day as string | undefined) ??
    undefined;

  const rpRes = await bridgeFetch(
    "POST",
    "/api/sync/enqueue",
    {
      type: "receive-payment",
      action: "add",
      data: {
        customerId: cp.customer_list_id,
        invoiceId: checkTxnId,
        creditTxnId: creditTxnId,
        amount: Number(amountDollars),
        totalAmount: 0,
        paymentAmount: 0,
        ...(rpTxnDate ? { date: rpTxnDate } : {}),
      },
    },
    { idempotencyKey: `refund-payment:${rpRow.reference_id}` }
  );
  if (!rpRes?.operation_id) {
    logger.warn(
      `${LOG_PREFIX} ⚠️ ${logLabel}Bridge did not return operation_id for refund_payment ${rpRow.id}`
    );
    return false;
  }

  await pool.query(
    `UPDATE qb_order_pipeline
        SET status = 'submitted', bridge_op_id = $2, submitted_at = NOW(),
            error = NULL, updated_at = NOW()
      WHERE id = $1`,
    [rpRow.id, rpRes.operation_id]
  );
  logger.info(
    `${LOG_PREFIX} ✅ ${logLabel}refund_payment ${rpRow.id} activated (${rpPayload.type ?? "direct"}) → bridge op ${rpRes.operation_id}`
  );
  return true;
}
