import { SubscriberArgs } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { FINANCE_MODULE } from "../../../modules/finance";
import { bridgeFetch, pollRawOperationResult } from "../client/core";
import { unapplyPaymentFromInvoiceInQb } from "../qb-bridge-client";
import { getLatestInvoiceTxnId } from "../qb-metadata-types";

const LOG_PREFIX = "[QB-POS-PAYMENT-UNAPPLIED]";
const ENABLED = process.env.QB_ORDER_FLOW_ENABLED === "true";

export async function handlePosPaymentUnapplied({
  event,
  container,
}: SubscriberArgs<any>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);

  if (!ENABLED) {
    logger.info(
      `${LOG_PREFIX} ⏭️ QB_ORDER_FLOW_ENABLED=false — skipping ${event.name}`
    );
    return;
  }

  const { payment_id, invoice_id } = event.data;
  if (!payment_id || !invoice_id) {
    logger.warn(
      `${LOG_PREFIX} Missing required fields in event data: ${JSON.stringify(event.data)}`
    );
    return;
  }

  logger.info(
    `${LOG_PREFIX} 📥 Received ${event.name} for payment ${payment_id} -> invoice ${invoice_id}`
  );

  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const financeService = container.resolve(FINANCE_MODULE);

  // 1. Fetch the payment to get the QB TxnId
  const payment = await financeService.retrieveCustomerPayment(payment_id);
  if (!payment) {
    logger.error(`${LOG_PREFIX} Payment ${payment_id} not found in DB!`);
    return;
  }

  // SALES RECEIPT GUARD: payments embedded in a QB Sales Receipt cannot be unapplied —
  // the SR transaction owns the payment and it's not a standalone ReceivePayment.
  if (payment.metadata?.qb_source === "sales_receipt") {
    logger.info(
      `${LOG_PREFIX} ⏭️ Skipping unapply: payment ${payment_id} was captured in a Sales Receipt — apply/unapply not supported in QB for SR payments`
    );
    return;
  }

  const paymentTxnId = payment.metadata?.qb_txn_id as string;
  if (!paymentTxnId) {
    logger.warn(
      `${LOG_PREFIX} Payment ${payment_id} has no qb_txn_id. Cannot unapply it in QuickBooks.`
    );
    return;
  }

  // 2. Fetch the target invoice's QB TxnId
  // Since we need to unapply from a specific QB Invoice, we need its TxnID.
  const {
    data: [invoice],
  } = await query.graph({
    entity: "pos_invoice",
    fields: ["id", "metadata"],
    filters: { id: invoice_id },
  });

  if (!invoice || !invoice.metadata) {
    logger.warn(
      `${LOG_PREFIX} pos_invoice ${invoice_id} not found or missing metadata. Cannot find invoiceTxnId.`
    );
    return;
  }

  // Since POS invoices now store qb_txn_id directly, or we can use the helper
  let invoiceTxnId = invoice.metadata?.qb_txn_id as string;

  // Also try checking the Medusa Order just in case (fallback)
  if (!invoiceTxnId && invoice.order_id) {
    const {
      data: [order],
    } = await query.graph({
      entity: "order",
      fields: ["id", "metadata"],
      filters: { id: invoice.order_id },
    });
    invoiceTxnId = getLatestInvoiceTxnId(order?.metadata || {}) || "";
  }

  if (!invoiceTxnId) {
    logger.error(
      `${LOG_PREFIX} ❌ Invoice TxnID not found for pos_invoice ${invoice_id}. Cannot unapply payment ${paymentTxnId}.`
    );
    return;
  }

  // 3. Fetch EditSequence by polling QBXML via the Bridge
  logger.info(
    `${LOG_PREFIX} 🔍 Fetching Payment ${paymentTxnId} from QB to get EditSequence...`
  );

  let editSequence: string | undefined;
  try {
    const paymentData = await bridgeFetch(
      "GET",
      `/api/payments/${paymentTxnId}`
    );
    const operationId = paymentData?.operationId;
    if (!operationId) {
      throw new Error("No operationId returned for payment query");
    }

    logger.info(
      `${LOG_PREFIX} ⏳ Waiting for QB response (Operation ID: ${operationId})...`
    );
    const rawResult = await pollRawOperationResult(operationId, (msg: string) =>
      logger.info(msg)
    );

    const resObj =
      rawResult?.QBXML?.QBXMLMsgsRs?.ReceivePaymentQueryRs?.ReceivePaymentRet ??
      rawResult?.ReceivePaymentQueryRs?.ReceivePaymentRet ??
      rawResult?.ReceivePaymentRet;

    editSequence = resObj?.EditSequence;

    if (!editSequence) {
      logger.error(
        `${LOG_PREFIX} ❌ Could not find EditSequence in QB response for Payment ${paymentTxnId}`
      );
      return;
    }
  } catch (err: any) {
    logger.error(
      `${LOG_PREFIX} ❌ Failed to fetch EditSequence: ${err.message}`
    );
    return;
  }

  // 4. Fire the Bridge Request to Unapply Payment from Invoice!
  logger.info(
    `${LOG_PREFIX} 🎯 Unapplying Payment (TxnID: ${paymentTxnId}) from Invoice (TxnID: ${invoiceTxnId}) in QB...`
  );

  const applyResult = await unapplyPaymentFromInvoiceInQb({
    creditTxnId: paymentTxnId,
    invoiceId: invoiceTxnId,
    editSequence: editSequence,
  });

  if (!applyResult.success) {
    logger.error(
      `${LOG_PREFIX} ❌ Failed to unapply payment in QB: ${applyResult.error}`
    );
  } else {
    const opId = applyResult.data?.operationId;
    if (opId && opId !== "DRY_RUN") {
      logger.info(
        `${LOG_PREFIX} ✅ Unapplication request queued. OperationID: ${opId}`
      );
      // Note: Since this is an async operation that is decoupled locally, we don't necessarily
      // need to poll for the final `ReceivePaymentMod` return value unless we want to log it.
    } else {
      logger.info(`${LOG_PREFIX} ✅ Dry-run or instant success reported.`);
    }
  }
}
