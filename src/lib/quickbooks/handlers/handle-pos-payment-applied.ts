import { SubscriberArgs } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { FINANCE_MODULE } from "../../../modules/finance";
import {
  mergeApplyPaymentInQb,
  applyCreditMemoToInvoiceInQb,
} from "../qb-bridge-client";
import { withQbLockResult } from "../qb-locks";
import { writePipelineRow, cacheEditSequence } from "../qb-pipeline";
import { getDbPool } from "../../../api/utils/db-pool";

const LOG_PREFIX = "[QB-POS-PAYMENT-APPLIED]";
const ENABLED = process.env.QB_ORDER_FLOW_ENABLED === "true";

export async function handlePosPaymentApplied({
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

  const { payment_id, invoice_id, order_id, amount_applied } = event.data;
  if (!payment_id || !invoice_id || !order_id) {
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

  // SALES RECEIPT GUARD: payments embedded in a QB Sales Receipt cannot be applied
  // to an invoice separately — the SR already captures the full transaction.
  if (payment.metadata?.qb_source === "sales_receipt") {
    logger.info(
      `${LOG_PREFIX} ⏭️ Skipping apply: payment ${payment_id} was captured in a Sales Receipt — apply/unapply not supported in QB for SR payments`
    );
    return;
  }

  let paymentTxnId = payment.metadata?.qb_txn_id as string | undefined;
  // Declare here so it's available in all early-exit error paths below
  const medusaPayRef = (payment as any).display_id
    ? `PAY-${(payment as any).display_id}`
    : null;

  // Short-circuit: if this is a credit_memo payment with no QB TxnId yet, the
  // credit memo itself may still be in the pipeline. Enqueue apply_payment as
  // 'waiting' with depends_on so the consolidator dispatches it automatically
  // once the CM is confirmed — avoiding the 400s polling loop.
  if (!paymentTxnId && (payment as any).type === "credit_memo") {
    try {
      const pool = getDbPool();
      const cmRef = (payment as any).reference as string | undefined;
      if (cmRef) {
        const { rows: cmPipelineRows } = await pool.query(
          `SELECT q.id FROM qb_order_pipeline q
             JOIN pos_credit_memo cm ON cm.id = q.reference_id
            WHERE cm.credit_memo_number = $1
              AND q.step = 'credit_memo'
              AND q.status IN ('pending', 'submitted', 'waiting')
            ORDER BY q.created_at DESC LIMIT 1`,
          [cmRef]
        );
        if (cmPipelineRows[0]) {
          const cmPipelineId = cmPipelineRows[0].id as string;
          await writePipelineRow({
            orderId: order_id,
            referenceId: payment_id,
            referenceType: "customer_payment",
            step: "apply_payment",
            status: "waiting",
            dependsOn: cmPipelineId,
            medusaRefNumber: medusaPayRef,
          }).catch(() => {});
          logger.info(
            `${LOG_PREFIX} ⏸️ apply_payment enqueued as waiting (depends_on CM pipeline row ${cmPipelineId}) — will auto-dispatch when CM is confirmed`
          );
          return;
        }
      }
    } catch (depErr: any) {
      logger.warn(
        `${LOG_PREFIX} Could not set up CM dependency, falling back to polling: ${depErr.message}`
      );
    }
  }

  // Wait for the payment to finish syncing to QB if it hasn't yet (up to 400 seconds)
  if (!paymentTxnId) {
    logger.info(
      `${LOG_PREFIX} ⏳ Payment TxnID not found immediately. Polling for up to 400 seconds to let Payment Sync finish...`
    );
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, 20000));
      const refreshedPayment = await financeService
        .retrieveCustomerPayment(payment_id)
        .catch(() => null);
      paymentTxnId = refreshedPayment?.metadata?.qb_txn_id as
        | string
        | undefined;
      const currentStatus = refreshedPayment?.metadata?.qb_sync_status;

      if (paymentTxnId) {
        logger.info(
          `${LOG_PREFIX} ⏳ Found paymentTxnId: ${paymentTxnId} on attempt ${i + 1}`
        );
        break;
      }
      if (currentStatus === "error") {
        logger.error(
          `${LOG_PREFIX} ❌ Payment sync failed with status 'error'. Aborting application logic.`
        );
        break;
      }
    }
  }

  if (!paymentTxnId) {
    logger.warn(
      `${LOG_PREFIX} Payment ${payment_id} still has no qb_txn_id after polling. Cannot apply it in QuickBooks.`
    );
    try {
      await writePipelineRow({
        orderId: order_id,
        referenceId: payment_id,
        referenceType: "customer_payment",
        step: "apply_payment",
        status: "failed",
        medusaRefNumber: medusaPayRef,
        error:
          "Payment not yet synced to QB — retry after payment is confirmed",
      });
    } catch {}
    return;
  }

  // 2. Fetch the Invoice metadata to get the qb_txn_id
  const {
    data: [invoice],
  } = await query.graph({
    entity: "pos_invoice",
    fields: ["id", "invoice_number", "metadata"],
    filters: { id: invoice_id },
  });

  if (!invoice) {
    logger.warn(
      `${LOG_PREFIX} Invoice ${invoice_id} not found. Cannot apply payment.`
    );
    await writePipelineRow({
      orderId: order_id,
      referenceId: payment_id,
      referenceType: "customer_payment",
      step: "apply_payment",
      status: "failed",
      medusaRefNumber: medusaPayRef,
      error: `Invoice ${invoice_id} not found in DB`,
    }).catch(() => {});
    return;
  }

  let invoiceTxnId = invoice.metadata?.qb_txn_id as string | undefined;
  let invoiceNumber = (invoice as any).invoice_number as string | undefined;

  // Fallback: if pos_invoice.metadata.qb_txn_id is missing but the pipeline row
  // is already confirmed, use the TxnID directly from the pipeline table.
  // This handles cases where poll-submitted-rows failed to write back to metadata.
  if (!invoiceTxnId) {
    try {
      const fbPool = getDbPool();
      const { rows: pipelineRows } = await fbPool.query(
        `SELECT qb_txn_id, qb_ref_number FROM qb_order_pipeline
          WHERE reference_id = $1
            AND step IN ('invoice', 'sales_receipt')
            AND status = 'confirmed'
            AND qb_txn_id IS NOT NULL
          ORDER BY confirmed_at DESC LIMIT 1`,
        [invoice_id]
      );
      if (pipelineRows[0]?.qb_txn_id) {
        invoiceTxnId = pipelineRows[0].qb_txn_id as string;
        logger.info(
          `${LOG_PREFIX} 📋 Invoice TxnID sourced from confirmed pipeline row: ${invoiceTxnId}`
        );
        // Also backfill pos_invoice.metadata so future calls are fast
        await fbPool.query(
          `UPDATE pos_invoice
              SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
            WHERE id = $1`,
          [
            invoice_id,
            JSON.stringify({
              qb_txn_id: invoiceTxnId,
              qb_ref_number: pipelineRows[0].qb_ref_number ?? undefined,
              qb_sync_status: "synced",
            }),
          ]
        );
      }
    } catch (fbErr: any) {
      logger.warn(
        `${LOG_PREFIX} Pipeline fallback for invoice TxnID failed: ${fbErr.message}`
      );
    }
  }

  // 3. Polling for up to 100 seconds if the Invoice hasn't finished syncing yet (10 attempts of 10 seconds)
  if (!invoiceTxnId) {
    logger.info(
      `${LOG_PREFIX} ⏳ Invoice TxnID not found immediately. Polling for up to 100 seconds to let Invoice Sync finish...`
    );
    for (let i = 0; i < 10; i++) {
      await new Promise((res) => setTimeout(res, 10000));
      const {
        data: [refreshedInvoice],
      } = await query.graph({
        entity: "pos_invoice",
        fields: ["invoice_number", "metadata"],
        filters: { id: invoice_id },
      });
      invoiceTxnId = refreshedInvoice?.metadata?.qb_txn_id as
        | string
        | undefined;
      const currentInvStatus = refreshedInvoice?.metadata?.qb_sync_status;
      if (refreshedInvoice?.invoice_number)
        invoiceNumber = refreshedInvoice.invoice_number as string;

      if (invoiceTxnId) {
        logger.info(
          `${LOG_PREFIX} ⏳ Found invoiceTxnId: ${invoiceTxnId} on attempt ${i + 1}`
        );
        break;
      }
      if (currentInvStatus === "error") {
        logger.error(
          `${LOG_PREFIX} ❌ Invoice sync failed with status 'error'. Aborting application logic.`
        );
        break;
      }
    }
  }

  if (!invoiceTxnId) {
    logger.error(
      `${LOG_PREFIX} ❌ Timed out waiting for Invoice TxnID on order ${order_id}. Cannot apply payment ${paymentTxnId}.`
    );
    await writePipelineRow({
      orderId: order_id,
      referenceId: payment_id,
      referenceType: "customer_payment",
      step: "apply_payment",
      status: "failed",
      medusaRefNumber: medusaPayRef,
      error:
        "Timed out waiting for Invoice to sync to QB — retry after invoice is confirmed",
    }).catch(() => {});
    return;
  }

  // 4. Write pre-flight pipeline row
  try {
    await writePipelineRow({
      orderId: order_id,
      referenceId: payment_id,
      referenceType: "customer_payment",
      step: "apply_payment",
      status: "pending",
      medusaRefNumber: medusaPayRef,
    });
  } catch (pErr: any) {
    logger.warn(
      `${LOG_PREFIX} Could not write pre-flight pipeline row: ${pErr.message}`
    );
  }

  // 5. Fire the Bridge Request to Apply Payment to Invoice!
  logger.info(
    `${LOG_PREFIX} 🎯 Applying Payment (TxnID: ${paymentTxnId}, Amount: $${(amount_applied / 100).toFixed(2)}) -> Invoice (TxnID: ${invoiceTxnId}) in QB...`
  );

  // Fetch the customer based on the order to get QB List ID if needed
  // (applyPaymentToInvoiceInQb needs customerId)
  const {
    data: [customer],
  } = await query.graph({
    entity: "customer",
    fields: ["id", "metadata"],
    filters: { id: payment.customer_id },
  });

  const customerQbId = customer?.metadata?.qb_list_id as string | undefined;

  if (!customerQbId) {
    logger.error(
      `${LOG_PREFIX} ❌ Customer ${payment.customer_id} has no qb_list_id. Cannot apply payment.`
    );
    await writePipelineRow({
      orderId: order_id,
      referenceId: payment_id,
      referenceType: "customer_payment",
      step: "apply_payment",
      status: "failed",
      medusaRefNumber: medusaPayRef,
      error: `Customer ${payment.customer_id} not synced to QB — no qb_list_id`,
    }).catch(() => {});
    return;
  }

  // Build updated memo: replace the original "for Order X" with "for Invoice Y"
  // so the QB payment reflects its final use instead of the original deposit context.
  const payDisplayId = (payment as any).display_id;
  const updatedMemo = invoiceNumber
    ? payDisplayId
      ? `Payment ${payDisplayId} for Invoice ${invoiceNumber}`
      : `Payment for Invoice ${invoiceNumber}`
    : undefined;

  // ─────────────────────────────────────────────────────────────────────────
  // Routing: credit_memo payments carry a CreditMemo TxnID, not a ReceivePayment
  // TxnID. Applying them requires ReceivePaymentAdd+SetCredit (a new record),
  // not ReceivePaymentMod of an existing one. All other payments use merge-apply.
  // ─────────────────────────────────────────────────────────────────────────
  const isCreditMemoPayment = (payment as any).type === "credit_memo";

  // Write `submitted` with bridgeOpId as soon as the op is enqueued to the bridge,
  // before polling for completion. This prevents orphaned `pending` rows if the
  // process crashes or restarts during the poll.
  const onQueued = async (opId: string) => {
    await writePipelineRow({
      orderId: order_id,
      referenceId: payment_id,
      referenceType: "customer_payment",
      step: "apply_payment",
      status: "submitted",
      medusaRefNumber: medusaPayRef,
      bridgeOpId: opId,
    }).catch((e: any) =>
      logger.warn(`${LOG_PREFIX} Could not write submitted row: ${e.message}`)
    );
  };

  await withQbLockResult(`qb-payment:${paymentTxnId}`, async () => {
    const applyResult = isCreditMemoPayment
      ? await applyCreditMemoToInvoiceInQb({
          customerId: customerQbId,
          creditMemoTxnId: paymentTxnId!,
          invoiceTxnId: invoiceTxnId!,
          amount: amount_applied / 100,
          memo: updatedMemo,
          log: (m: string) => logger.info(m),
          onQueued,
        })
      : await mergeApplyPaymentInQb({
          customerId: customerQbId,
          invoiceId: invoiceTxnId!,
          amount: amount_applied / 100,
          creditTxnId: paymentTxnId!,
          memo: updatedMemo,
          log: (m: string) => logger.info(m),
          onQueued,
        });

    if (!applyResult.success) {
      logger.error(
        `${LOG_PREFIX} ❌ Failed to merge-apply payment in QB: ${applyResult.error}`
      );
      try {
        await writePipelineRow({
          orderId: order_id,
          referenceId: payment_id,
          referenceType: "customer_payment",
          step: "apply_payment",
          status: "failed",
          medusaRefNumber: medusaPayRef,
          error: applyResult.error || "Merge-apply failed",
        });
      } catch {}
      return;
    }

    const opId = applyResult.data?.operationId;
    const newSeq = applyResult.data?.newEditSequence;
    const totalApplied = applyResult.data?.totalAppliedCount ?? 0;

    if (opId && opId !== "DRY_RUN") {
      logger.info(
        `${LOG_PREFIX} ✅ Merge-apply confirmed. OperationID: ${opId}, now applied to ${totalApplied} invoice(s), new EditSeq: ${newSeq ?? "<not-returned>"}`
      );
      if (newSeq) {
        await cacheEditSequence("payment", paymentTxnId!, newSeq).catch(
          (e: any) =>
            logger.warn(
              `${LOG_PREFIX} Could not cache new EditSequence: ${e.message}`
            )
        );
      }
      await writePipelineRow({
        orderId: order_id,
        referenceId: payment_id,
        referenceType: "customer_payment",
        step: "apply_payment",
        status: "confirmed",
        medusaRefNumber: medusaPayRef,
        bridgeOpId: opId,
        qbTxnId: paymentTxnId!,
      }).catch(() => {});
    } else {
      logger.info(`${LOG_PREFIX} ✅ Dry-run or instant success reported.`);
      await writePipelineRow({
        orderId: order_id,
        referenceId: payment_id,
        referenceType: "customer_payment",
        step: "apply_payment",
        status: "confirmed",
        medusaRefNumber: medusaPayRef,
      }).catch(() => {});
    }

    await financeService
      .updateCustomerPayments({
        id: payment_id,
        metadata: { ...(payment.metadata || {}), qb_sync_status: "synced" },
      })
      .catch((err: any) =>
        logger.warn(
          `${LOG_PREFIX} ⚠️ Could not update qb_sync_status to synced: ${err.message}`
        )
      );
  });
}
