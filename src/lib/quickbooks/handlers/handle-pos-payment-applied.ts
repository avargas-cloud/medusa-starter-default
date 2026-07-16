import { SubscriberArgs } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { FINANCE_MODULE } from "../../../modules/finance";
import {
  mergeApplyPaymentInQb,
  applyCreditMemoToInvoiceInQb,
} from "../qb-bridge-client";
import { withQbLockResult } from "../qb-locks";
import {
  writePipelineRow,
  cacheEditSequence,
  requeueApplyPaymentWaiting,
  resolveCanonicalApplyPaymentRef,
} from "../qb-pipeline";
import { getDbPool } from "../../../api/utils/db-pool";

/**
 * Resolves the source pipeline row id for a customer_payment:
 *   - type='credit_memo' → looks up the qb_order_pipeline row for the originating
 *     credit memo (matched by pos_credit_memo.credit_memo_number = cpay.reference)
 *   - any other type     → looks up the qb_order_pipeline row for the cpay's own
 *     'payment' step (reference_id = cpay.id)
 *
 * Returns null if no row exists yet (caller should fall back to fail/wait logic).
 */
async function resolveSourcePipelineRowId(
  pool: any,
  cpay: { id: string; type?: string | null; reference?: string | null }
): Promise<string | null> {
  if (cpay.type === "credit_memo" && cpay.reference) {
    const { rows } = await pool.query(
      `SELECT q.id FROM qb_order_pipeline q
         JOIN pos_credit_memo cm ON cm.id = q.reference_id
        WHERE cm.credit_memo_number = $1
          AND q.step = 'credit_memo'
          AND q.status NOT IN ('skipped')
        ORDER BY q.created_at DESC LIMIT 1`,
      [cpay.reference]
    );
    return rows[0]?.id ?? null;
  }
  const { rows } = await pool.query(
    `SELECT id FROM qb_order_pipeline
      WHERE step = 'payment'
        AND reference_id = $1
        AND status NOT IN ('skipped')
      ORDER BY created_at DESC LIMIT 1`,
    [cpay.id]
  );
  return rows[0]?.id ?? null;
}

/**
 * Resolves the qb_order_pipeline row id for an invoice (the target of an apply_payment).
 */
async function resolveInvoicePipelineRowId(
  pool: any,
  invoiceId: string
): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT id FROM qb_order_pipeline
      WHERE step IN ('invoice', 'sales_receipt')
        AND reference_id = $1
        AND status NOT IN ('skipped')
      ORDER BY created_at DESC LIMIT 1`,
    [invoiceId]
  );
  return rows[0]?.id ?? null;
}

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

  const { payment_id, invoice_id, order_id, amount_applied, application_id } =
    event.data;
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

  const paymentTxnId = payment.metadata?.qb_txn_id as string | undefined;
  // Declare here so it's available in all early-exit error paths below
  const medusaPayRef = (payment as any).display_id
    ? `PAY-${(payment as any).display_id}`
    : null;
  // Canonical keying: apply_payment rows MUST key reference_id by
  // payment_application.id (papp_) so the dedup in writePipelineRow /
  // requeueApplyPaymentWaiting matches across ALL callers. Some callers (notably
  // the pipeline Retry endpoint, post-pipeline.ts) emit this event WITHOUT
  // application_id; falling straight back to payment_id (cpay_) created a
  // DUPLICATE apply_payment row alongside the route's papp_ row (the dual-keying
  // bug). resolveCanonicalApplyPaymentRef recovers the papp_ id when missing.
  let applyRef;
  try {
    applyRef = await resolveCanonicalApplyPaymentRef({
      applicationId: application_id,
      paymentId: payment_id,
      invoiceId: invoice_id,
    });
  } catch (refErr: any) {
    logger.warn(
      `${LOG_PREFIX} resolveCanonicalApplyPaymentRef failed for ${payment_id}/${invoice_id}: ${refErr.message} — using legacy customer_payment key`
    );
    applyRef = {
      referenceId: payment_id,
      referenceType: "customer_payment" as const,
      resolvedFromLookup: false,
    };
  }
  if (applyRef.resolvedFromLookup) {
    logger.info(
      `${LOG_PREFIX} Recovered missing application_id → ${applyRef.referenceId} for payment ${payment_id} / invoice ${invoice_id} (prevents cpay_/papp_ duplicate)`
    );
  } else if (applyRef.referenceType === "customer_payment") {
    logger.warn(
      `${LOG_PREFIX} No payment_application for payment ${payment_id} / invoice ${invoice_id} — using legacy customer_payment key; dedup may not catch a concurrent papp_ row`
    );
  }
  const applyReferenceId = applyRef.referenceId;
  const applyReferenceType = applyRef.referenceType;

  // ── Source dependency check ──────────────────────────────────────────────
  // The cpay carries the source TxnID (a Payment TxnID for type='payment',
  // a CreditMemo TxnID for type='credit_memo'). If it's not yet in QB, requeue
  // this apply_payment row to wait on the source pipeline row in-place.
  // The wake-dependents pass will auto-dispatch when the source confirms.
  if (!paymentTxnId) {
    const pool = getDbPool();
    const sourceRowId = await resolveSourcePipelineRowId(pool, {
      id: payment_id,
      type: (payment as any).type,
      reference: (payment as any).reference,
    }).catch(() => null);

    if (sourceRowId) {
      const { mode } = await requeueApplyPaymentWaiting({
        orderId: order_id,
        referenceId: applyReferenceId,
        referenceType: applyReferenceType,
        dependsOnRowId: sourceRowId,
        medusaRefNumber: medusaPayRef,
      });
      logger.info(
        `${LOG_PREFIX} ⏸️ apply_payment ${mode}: waiting on source pipeline row ${sourceRowId} (cpay type=${(payment as any).type}) — will auto-dispatch when source confirms`
      );
      return;
    }

    // No source pipeline row exists yet — mark failed so it surfaces in UI
    // for manual investigation. Common causes: cpay was created before the QB
    // sync flow was enabled, or the source step was manually skipped.
    logger.warn(
      `${LOG_PREFIX} Payment ${payment_id} has no qb_txn_id and no resolvable source pipeline row.`
    );
    try {
      await writePipelineRow({
        orderId: order_id,
        referenceId: applyReferenceId,
        referenceType: applyReferenceType,
        step: "apply_payment",
        status: "failed",
        medusaRefNumber: medusaPayRef,
        error:
          "Payment not yet synced to QB and no source pipeline row found — investigate the source payment/credit-memo",
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
      referenceId: applyReferenceId,
      referenceType: applyReferenceType,
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

  // ── Target dependency check ──────────────────────────────────────────────
  // The invoice carries the target TxnID. If it's not yet in QB, requeue this
  // apply_payment row to wait on the invoice pipeline row in-place. The
  // wake-dependents pass will auto-dispatch when the invoice confirms.
  if (!invoiceTxnId) {
    const pool = getDbPool();
    const invoicePipelineId = await resolveInvoicePipelineRowId(
      pool,
      invoice_id
    ).catch(() => null);

    if (invoicePipelineId) {
      const { mode } = await requeueApplyPaymentWaiting({
        orderId: order_id,
        referenceId: applyReferenceId,
        referenceType: applyReferenceType,
        dependsOnRowId: invoicePipelineId,
        medusaRefNumber: medusaPayRef,
      });
      logger.info(
        `${LOG_PREFIX} ⏸️ apply_payment ${mode}: waiting on invoice pipeline row ${invoicePipelineId} — will auto-dispatch when invoice confirms`
      );
      return;
    }

    logger.error(
      `${LOG_PREFIX} ❌ Invoice ${invoice_id} has no qb_txn_id and no resolvable pipeline row.`
    );
    await writePipelineRow({
      orderId: order_id,
      referenceId: applyReferenceId,
      referenceType: applyReferenceType,
      step: "apply_payment",
      status: "failed",
      medusaRefNumber: medusaPayRef,
      error:
        "Invoice not yet synced to QB and no invoice pipeline row found — investigate the source invoice",
    }).catch(() => {});
    return;
  }

  // 4. Write pre-flight pipeline row
  try {
    await writePipelineRow({
      orderId: order_id,
      referenceId: applyReferenceId,
      referenceType: applyReferenceType,
      step: "apply_payment",
      status: "pending",
      medusaRefNumber: medusaPayRef,
    });
  } catch (pErr: any) {
    logger.warn(
      `${LOG_PREFIX} Could not write pre-flight pipeline row: ${pErr.message}`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Routing: credit_memo payments carry a CreditMemo TxnID, not a ReceivePayment
  // TxnID. Applying them requires ReceivePaymentAdd+SetCredit (a new record),
  // not ReceivePaymentMod of an existing one. All other payments use merge-apply.
  // ─────────────────────────────────────────────────────────────────────────
  const isCreditMemoPayment = (payment as any).type === "credit_memo";

  // ── Aggregate amount for merge-apply (split-safe) ────────────────────────
  // CONVERT-ON-APPLY can split one logical apply into TWO payment_application
  // rows (convert + surplus) for the same (payment, invoice), each with its
  // own papp_ pipeline row. mergeApplyPaymentInQb REPLACES the per-invoice
  // amount inside the ReceivePayment (read-merge-replace) — dispatching a
  // single row's partial amount would clobber the previously-applied share
  // (e.g. $500 convert then $300 surplus would leave QB at $300, not $800).
  // Always send the SUM of ALL active applications for this (payment, invoice):
  // every row's dispatch then writes the same correct total, so ordering and
  // redundant dispatches become harmless. The credit_memo path is EXCLUDED —
  // it ADDs a new ReceivePayment per dispatch (not idempotent), so sending the
  // aggregate there would double-apply; per-row amounts remain correct for it.
  let amountForQbCents = Number(amount_applied);
  if (!isCreditMemoPayment) {
    try {
      const aggPool = getDbPool();
      const { rows: aggRows } = await aggPool.query(
        `SELECT COALESCE(SUM(amount_applied), 0) AS total
           FROM payment_application
          WHERE payment_id = $1
            AND invoice_id = $2
            AND voided_at IS NULL`,
        [payment_id, invoice_id]
      );
      const aggregate = Number(aggRows[0]?.total ?? 0);
      if (Number.isFinite(aggregate) && aggregate > 0) {
        if (Math.round(aggregate) !== Math.round(amountForQbCents)) {
          logger.info(
            `${LOG_PREFIX} Split-aware aggregate: event carried ${amountForQbCents}¢ but active applications for payment ${payment_id} → invoice ${invoice_id} total ${aggregate}¢ — applying the aggregate.`
          );
        }
        amountForQbCents = aggregate;
      } else {
        // No active application left (all voided since this row was written) —
        // applying the event amount would re-apply voided money. Skip.
        logger.info(
          `${LOG_PREFIX} ⏭️ No active applications remain for payment ${payment_id} → invoice ${invoice_id} (aggregate=${aggregate}) — skipping apply.`
        );
        await writePipelineRow({
          orderId: order_id,
          referenceId: applyReferenceId,
          referenceType: applyReferenceType,
          step: "apply_payment",
          status: "skipped",
          medusaRefNumber: medusaPayRef,
          error:
            "apply_payment: no active payment_application remains for this payment+invoice (aggregate <= 0) — auto-skipped",
        }).catch(() => {});
        return;
      }
    } catch (aggErr: any) {
      logger.warn(
        `${LOG_PREFIX} Aggregate lookup failed (${aggErr.message}) — falling back to event amount ${amountForQbCents}¢`
      );
    }
  }

  // 5. Fire the Bridge Request to Apply Payment to Invoice!
  logger.info(
    `${LOG_PREFIX} 🎯 Applying Payment (TxnID: ${paymentTxnId}, Amount: $${(amountForQbCents / 100).toFixed(2)}) -> Invoice (TxnID: ${invoiceTxnId}) in QB...`
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
      referenceId: applyReferenceId,
      referenceType: applyReferenceType,
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

  // Write `submitted` with bridgeOpId as soon as the op is enqueued to the bridge,
  // before polling for completion. This prevents orphaned `pending` rows if the
  // process crashes or restarts during the poll.
  const onQueued = async (opId: string) => {
    await writePipelineRow({
      orderId: order_id,
      referenceId: applyReferenceId,
      referenceType: applyReferenceType,
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
          // Split-safe aggregate (see block above) — the merge REPLACES the
          // per-invoice amount in QB, so it must always carry the full total.
          amount: amountForQbCents / 100,
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
          referenceId: applyReferenceId,
          referenceType: applyReferenceType,
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
        referenceId: applyReferenceId,
        referenceType: applyReferenceType,
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
        referenceId: applyReferenceId,
        referenceType: applyReferenceType,
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
