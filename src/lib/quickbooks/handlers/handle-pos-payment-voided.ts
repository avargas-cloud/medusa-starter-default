import { SubscriberArgs } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { FINANCE_MODULE } from "../../../modules/finance";
import { bridgeFetch } from "../client/core";
import { writePipelineRow } from "../qb-pipeline";

const LOG_PREFIX = "[QB-POS-PAYMENT-VOIDED]";
const ENABLED = process.env.QB_ORDER_FLOW_ENABLED === "true";

/**
 * Fires TxnVoid → ReceivePayment on the QB Bridge for a voided POS payment.
 * Called directly (setTimeout) from POST /admin/finance/payments/:id/void.
 *
 * QB Desktop behaviour: zeroes the amount to $0, prefixes memo with "VOID:",
 * reopens any applied invoices — full audit trail preserved.
 */
export async function handlePosPaymentVoided({
  event,
  container,
}: SubscriberArgs<any>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);

  if (!ENABLED) {
    logger.info(`${LOG_PREFIX} ⏭️ QB_ORDER_FLOW_ENABLED=false — skipping`);
    return;
  }

  const { payment_id } = event.data;
  if (!payment_id) {
    logger.warn(`${LOG_PREFIX} Missing payment_id in event data`);
    return;
  }

  logger.info(`${LOG_PREFIX} 📥 Processing void for payment ${payment_id}`);

  const financeService = container.resolve(FINANCE_MODULE) as any;

  // 1. Fetch the payment to get the QB TxnId
  const payment = await financeService.retrieveCustomerPayment(payment_id);
  if (!payment) {
    logger.error(`${LOG_PREFIX} Payment ${payment_id} not found`);
    return;
  }

  const orderId: string | undefined = payment.metadata?.order_id as
    | string
    | undefined;

  // Sales Receipt payments are embedded in a SR transaction — TxnVoid on the SR
  // is a separate operation not handled here.
  if (payment.metadata?.qb_source === "sales_receipt") {
    logger.info(
      `${LOG_PREFIX} ⏭️ Sales Receipt payment — void must be done on the SR itself, skipping standalone ReceivePayment void`
    );
    await financeService.updateCustomerPayments({
      id: payment_id,
      metadata: { ...(payment.metadata || {}), qb_sync_status: "voided" },
    });
    if (orderId) {
      await writePipelineRow({
        orderId,
        referenceId: payment_id,
        step: "payment",
        status: "confirmed",
      }).catch(() => {});
    }
    return;
  }

  const qbTxnId = payment.metadata?.qb_txn_id as string | undefined;

  if (!qbTxnId) {
    // Payment was never synced to QB (e.g. orphaned Dejavoo payment from CompleteOrderModal
    // that was superseded by a Sales Receipt). Mark voided locally and close the
    // pipeline row so it doesn't stay stuck in "waiting" forever.
    logger.warn(
      `${LOG_PREFIX} Payment ${payment_id} has no qb_txn_id — marking voided locally only`
    );
    await financeService.updateCustomerPayments({
      id: payment_id,
      metadata: { ...(payment.metadata || {}), qb_sync_status: "voided" },
    });
    if (orderId) {
      await writePipelineRow({
        orderId,
        referenceId: payment_id,
        step: "payment",
        status: "confirmed",
      }).catch(() => {});
    }
    return;
  }

  // 2. Set sync status to voiding (shows spinner in UI)
  try {
    await financeService.updateCustomerPayments({
      id: payment_id,
      metadata: { ...(payment.metadata || {}), qb_sync_status: "voiding" },
    });
  } catch (mErr: any) {
    logger.warn(`${LOG_PREFIX} Could not set voiding status: ${mErr.message}`);
  }

  // 3. Call QB Bridge: TxnVoid → ReceivePayment
  logger.info(
    `${LOG_PREFIX} 🎯 Voiding ReceivePayment TxnID=${qbTxnId} in QuickBooks...`
  );
  try {
    const result = await bridgeFetch("POST", `/api/payments/${qbTxnId}/void`);

    if (!result?.success) {
      throw new Error(result?.error ?? "Unknown bridge error");
    }

    logger.info(
      `${LOG_PREFIX} ✅ Void queued in QB Bridge. OperationID: ${result.operationId}`
    );

    await financeService.updateCustomerPayments({
      id: payment_id,
      metadata: {
        ...(payment.metadata || {}),
        qb_sync_status: "voided",
        qb_void_operation_id: result.operationId ?? null,
      },
    });
  } catch (err: any) {
    logger.error(
      `${LOG_PREFIX} ❌ Failed to void payment in QB: ${err.message}`
    );
    try {
      await financeService.updateCustomerPayments({
        id: payment_id,
        metadata: { ...(payment.metadata || {}), qb_sync_status: "error" },
      });
    } catch (_) {
      /* best effort */
    }
  }
}
