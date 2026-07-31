import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/utils";

import {
  bridgeFetch,
  DRY_RUN,
} from "../../../../../lib/quickbooks/client/core";
import { getBusinessDateString } from "../../../../../lib/quickbooks/order-flow-core";
import {
  writePipelineRow,
  getCachedEditSequence,
} from "../../../../../lib/quickbooks/qb-pipeline";
import {
  claimWriteCheckAttempt,
  releaseWriteCheckClaim,
  writeCheckIdempotencyKey,
} from "../../../../../lib/quickbooks/pipeline/claim-write-check";
import { FINANCE_MODULE } from "../../../../../modules/finance";

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * POST /admin/finance/qb-refunds/sync
 * Fire-and-forget: enqueues a WriteCheck to the bridge and writes a submitted
 * pipeline row. The consolidator cron confirms/fails it and updates CustomerPayment.qb.
 * Body: { customer_payment_id, qb_bank_account_id, refund_date? }
 *
 * refund_date ('YYYY-MM-DD', backdatable) is the REFUND DATE: it becomes the
 * payment's batch_day, metadata.refund_txn_date, and the TxnDate of BOTH QB
 * documents (the Write Check and the $0 apply ReceivePayment). Defaults to
 * today's ET business date. Changing it after the check is confirmed goes
 * through POST /admin/finance/qb-refunds/mod (CheckMod), never a re-run here.
 *
 * Supports both:
 *   - New style: original payment with status='refunded'/'partial_refunded'
 *   - Legacy:    separate record with type='refund'
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const { customer_payment_id, qb_bank_account_id, refund_date } = req.body as {
    customer_payment_id: string;
    qb_bank_account_id: string;
    refund_date?: string;
  };

  if (!customer_payment_id || !qb_bank_account_id) {
    return res
      .status(400)
      .json({ error: "Missing customer_payment_id or qb_bank_account_id" });
  }
  if (refund_date !== undefined && !DATE_ONLY_RE.test(refund_date)) {
    return res
      .status(400)
      .json({ error: "refund_date must be YYYY-MM-DD", code: "BAD_DATE" });
  }
  const refundDate = refund_date ?? getBusinessDateString(new Date());

  const financeService = req.scope.resolve(FINANCE_MODULE);
  const customerModule = req.scope.resolve(Modules.CUSTOMER);

  // 1. Fetch the CustomerPayment
  const payments = await financeService.listCustomerPayments({
    id: customer_payment_id,
  } as any);
  const payment = (payments as any[])[0];
  if (!payment)
    return res.status(404).json({ error: "CustomerPayment not found" });

  // Validate it's a refundable record
  const isLegacyRefund = payment.type === "refund";
  const isNewStyleRefund =
    payment.type !== "refund" &&
    ["refunded", "partial_refunded"].includes(payment.status);
  if (!isLegacyRefund && !isNewStyleRefund) {
    return res.status(400).json({ error: "Payment is not a refund" });
  }
  // `qb.status === 'yes'` alone does NOT mean "this refund has a Write Check":
  // on a type='credit_memo' payment the credit-memo confirm handler stamps
  // { status: 'yes', txn_id: <CreditMemo TxnID> } (poll-submitted-rows.ts), so a
  // store-credit refund whose CM synced first was blocked here forever. The only
  // marker of a live check is `check_txn_id` (written by the write_check confirm);
  // status flips to 'voided' after a revert, which must stay re-syncable.
  // Same predicate as qb-refunds/[id]/revert and /void.
  const paymentQb = payment.qb as
    | { status?: string; check_txn_id?: string | null }
    | null
    | undefined;
  if (paymentQb?.status === "yes" && paymentQb.check_txn_id) {
    return res.status(400).json({ error: "Already synced to QuickBooks" });
  }

  // 1a. ANTI-DUPLICATE guard (CheckAdd is NOT idempotent): if the latest
  //     write_check row is in flight or already confirmed, a re-run here would
  //     mint a SECOND QB check (this route hits the bridge BEFORE
  //     writePipelineRow, so the pipeline-level ADD guard alone can't stop it).
  //     In-flight → wait; confirmed → use the mod route (change bank/date).
  const pgConnection = req.scope.resolve("__pg_connection__") as any;
  const { rows: wcRows } = await pgConnection.raw(
    `SELECT status FROM qb_order_pipeline
      WHERE step = 'write_check' AND reference_id = ?
      ORDER BY COALESCE(updated_at, created_at) DESC
      LIMIT 1`,
    [customer_payment_id]
  );
  const latestWcStatus = wcRows?.[0]?.status as string | undefined;
  if (latestWcStatus === "processing" || latestWcStatus === "submitted") {
    return res.status(409).json({
      error:
        "A QB Write Check for this refund is already in flight. Wait for it to confirm or fail before retrying.",
      code: "WRITE_CHECK_IN_FLIGHT",
    });
  }
  if (latestWcStatus === "confirmed") {
    return res.status(409).json({
      error:
        "The QB Write Check for this refund is already confirmed. Use the edit flow (qb-refunds/mod) to change bank or date.",
      code: "WRITE_CHECK_ALREADY_CONFIRMED",
    });
  }

  // 1b. Guard: for new-style refunds the payment IS the original — check its QB sync status.
  //     For legacy refunds, check the original payment referenced in notes.
  if (isNewStyleRefund) {
    const qbSynced =
      payment.metadata?.qb_sync_status === "synced" ||
      !!payment.metadata?.qb_txn_id;
    if (!qbSynced) {
      return res.status(400).json({
        error:
          "Original payment has not been confirmed in QuickBooks yet. Wait for it to sync before processing the refund.",
        code: "ORIGINAL_PAYMENT_NOT_SYNCED",
      });
    }
  } else if (isLegacyRefund) {
    const originalPaymentIdMatch = (payment.notes ?? "").match(/cpay_\w+/);
    if (originalPaymentIdMatch) {
      try {
        const origPayments = await financeService.listCustomerPayments({
          id: originalPaymentIdMatch[0],
        } as any);
        const origPayment = (origPayments as any[])[0];
        if (origPayment) {
          const qbSynced =
            origPayment.metadata?.qb_sync_status === "synced" ||
            !!origPayment.metadata?.qb_txn_id;
          if (!qbSynced) {
            return res.status(400).json({
              error:
                "Original payment has not been confirmed in QuickBooks yet.",
              code: "ORIGINAL_PAYMENT_NOT_SYNCED",
            });
          }
        }
      } catch {
        // Non-fatal — proceed
      }
    }
  }

  // 2. Fetch the bank account
  const banks = await financeService.listQbBankAccounts({
    id: qb_bank_account_id,
  } as any);
  const bank = (banks as any[])[0];
  if (!bank) return res.status(404).json({ error: "Bank account not found" });
  if (bank.type !== "Bank") {
    return res.status(400).json({
      error: `Selected account "${bank.name}" is type "${bank.type}", not a Bank account. CheckAdd requires a Bank account.`,
    });
  }

  // 3. Fetch customer QB ListID
  let customer: any;
  try {
    customer = await customerModule.retrieveCustomer(payment.customer_id);
  } catch {
    return res.status(404).json({ error: "Customer not found" });
  }
  const customerListId = customer?.metadata?.qb_list_id;
  if (!customerListId) {
    return res.status(400).json({
      error: "Customer does not have a QB ListID — sync customer first",
    });
  }

  // 4. Determine refund amount and reference label
  //    New style: use metadata.refund_amount; legacy: use payment.amount
  const rawAmount =
    isNewStyleRefund && payment.metadata?.refund_amount
      ? Number(payment.metadata.refund_amount)
      : Number(payment.amount);
  const amountDollars = (rawAmount / 100).toFixed(2);

  const payLabel = payment.display_id
    ? `PAY-${payment.display_id}`
    : customer_payment_id.slice(-8).toUpperCase();
  const refLabel =
    payment.reference && payment.reference.length <= 20
      ? payment.reference
      : payLabel;
  const medusaRef = `Refund ${payLabel}`;

  // Persists the chosen refund date on the payment record: batch_day (drives
  // /payments Batch Date basis + payments-summary) and metadata.refund_txn_date
  // (drives the /accounting "Refund Date" column). received_at is deliberately
  // NOT touched — it remains the CM-completion timestamp ("Credit Memo Date").
  const persistRefundDate = async () => {
    const newMeta = {
      ...((payment.metadata as Record<string, unknown>) ?? {}),
      refund_txn_date: refundDate,
    };
    // batch_day is a TEXT day-key column ('YYYY-MM-DD'), not DATE
    await pgConnection.raw(
      `UPDATE customer_payment
          SET batch_day = ?, metadata = ?::jsonb
        WHERE id = ?`,
      [refundDate, JSON.stringify(newMeta), customer_payment_id]
    );
  };

  if (DRY_RUN) {
    await persistRefundDate();
    await writePipelineRow({
      referenceId: customer_payment_id,
      referenceType: "customer_payment",
      step: "write_check",
      status: "confirmed",
      qbTxnId: "DRY-RUN-CHECK-TXN",
      medusaRefNumber: refLabel,
      payload: { bankAccountId: qb_bank_account_id, txnDate: refundDate },
    });
    return res.json({ success: true, dry_run: true, refund_date: refundDate });
  }

  // 4b. CLAIM antes de tocar el bridge. El guard 1a de arriba es un SELECT y no
  //     puede cubrir dos requests concurrentes ni un reintento tras una respuesta
  //     perdida; esto gana la fila de pipeline primero (índice único parcial
  //     uq_qb_pipeline_write_check_live) y recién después emite el CheckAdd, que
  //     NO es idempotente. El id de la fila es el token de la idempotency key.
  const claim = await claimWriteCheckAttempt({
    referenceId: customer_payment_id,
    medusaRefNumber: medusaRef,
    payload: { bankAccountId: qb_bank_account_id, txnDate: refundDate },
  });
  if (!claim.ok) {
    return res.status(409).json({
      error:
        "A QB Write Check for this refund is already in flight. Wait for it to confirm or fail before retrying.",
      code: "WRITE_CHECK_IN_FLIGHT",
    });
  }

  // 5. Enqueue CheckAdd to bridge
  let enqueueRes: any;
  try {
    enqueueRes = await bridgeFetch(
      "POST",
      "/api/sync/enqueue",
      {
        type: "check",
        action: "add",
        data: {
          AccountRef: { ListID: bank.list_id },
          PayeeEntityRef: { ListID: customerListId },
          RefNumber: refLabel,
          TxnDate: refundDate,
          Memo: `POS Refund - ${refLabel}`,
          ExpenseLineAdd: [
            {
              AccountRef: { FullName: "Accounts Receivable" },
              Amount: amountDollars,
              Memo: `Refund for ${refLabel}`,
              CustomerRef: { ListID: customerListId },
            },
          ],
        },
      },
      // 1:1 con el cheque que este intento crea. Si el ADD entró pero perdimos la
      // respuesta, el reintento reusa la fila reclamada ⇒ la misma key ⇒ el bridge
      // devuelve la op existente en vez de mintear un segundo cheque.
      { idempotencyKey: writeCheckIdempotencyKey(claim.rowId) }
    );
  } catch (e: any) {
    // El ADD no llegó a QuickBooks: liberar el claim para que el operador pueda
    // reintentar (y que ese reintento conserve la key de este intento).
    await releaseWriteCheckClaim(
      claim.rowId,
      `Bridge enqueue failed: ${e.message}`
    );
    return res
      .status(500)
      .json({ error: `Bridge enqueue failed: ${e.message}` });
  }

  if (!enqueueRes?.operation_id) {
    await releaseWriteCheckClaim(
      claim.rowId,
      "Bridge did not return operation_id"
    );
    return res
      .status(500)
      .json({ error: "Bridge did not return operation_id" });
  }

  // 6. Write pipeline row as submitted + persist the refund date on the payment
  const writeCheckRowId = await writePipelineRow({
    referenceId: customer_payment_id,
    referenceType: "customer_payment",
    step: "write_check",
    status: "submitted",
    bridgeOpId: enqueueRes.operation_id,
    medusaRefNumber: medusaRef,
    payload: { bankAccountId: qb_bank_account_id, txnDate: refundDate },
  });
  await persistRefundDate();

  // 6b. ALL refunds need a refund_payment (ReceivePaymentAdd) to close the open AR
  //     from the Write Check against the original QB credit:
  //     - CM refunds: credit = Credit Memo TxnID
  //     - Direct payment refunds: credit = original ReceivePayment TxnID (qb_txn_id)
  const isCreditMemoRefund =
    payment.type === "credit_memo" ||
    (isLegacyRefund && String(payment.reference ?? "").startsWith("CM-"));

  const originalPaymentTxnId = isNewStyleRefund
    ? (payment.metadata?.qb_txn_id ?? null)
    : null; // legacy refunds: consolidator will look up original payment

  await writePipelineRow({
    referenceId: customer_payment_id,
    referenceType: "customer_payment",
    step: "refund_payment",
    status: "waiting",
    dependsOn: writeCheckRowId,
    medusaRefNumber: medusaRef,
    payload: isCreditMemoRefund
      ? {
          customerListId,
          creditMemoRef: payment.reference,
          type: "credit_memo",
          txnDate: refundDate,
        }
      : {
          customerListId,
          originalPaymentTxnId,
          type: "direct_payment",
          txnDate: refundDate,
        },
  });

  // 7. Update original ReceivePayment memo in QB to append "(Refunded)"
  //    Best-effort: skip silently if TxnID or EditSequence not available
  if (!isCreditMemoRefund && originalPaymentTxnId) {
    try {
      const editSeq =
        (await getCachedEditSequence("payment", originalPaymentTxnId))
          ?.editSeq ?? null;
      if (editSeq) {
        const origMemo = payment.metadata?.qb_memo as string | undefined;
        const newMemo = origMemo
          ? `${origMemo} (Refunded)`
          : `${payLabel} (Refunded)`;
        await bridgeFetch("POST", "/api/sync/enqueue", {
          type: "receive-payment",
          action: "mod",
          data: {
            TxnID: originalPaymentTxnId,
            EditSequence: editSeq,
            memo: newMemo,
          },
        });
      }
    } catch {
      // Non-critical — proceed without updating memo
    }
  }

  // 8. Mark as processing
  await financeService.updateCustomerPayments(
    { id: customer_payment_id },
    { qb: { status: "processing", operation_id: enqueueRes.operation_id } }
  );

  return res.json({
    success: true,
    queued: true,
    operation_id: enqueueRes.operation_id,
    refund_date: refundDate,
  });
};
