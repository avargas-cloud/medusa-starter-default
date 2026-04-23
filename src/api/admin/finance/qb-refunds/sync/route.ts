import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/utils";

import {
  bridgeFetch,
  DRY_RUN,
} from "../../../../../lib/quickbooks/client/core";
import {
  writePipelineRow,
  getCachedEditSequence,
} from "../../../../../lib/quickbooks/qb-pipeline";
import { FINANCE_MODULE } from "../../../../../modules/finance";

/**
 * POST /admin/finance/qb-refunds/sync
 * Fire-and-forget: enqueues a WriteCheck to the bridge and writes a submitted
 * pipeline row. The consolidator cron confirms/fails it and updates CustomerPayment.qb.
 * Body: { customer_payment_id, qb_bank_account_id }
 *
 * Supports both:
 *   - New style: original payment with status='refunded'/'partial_refunded'
 *   - Legacy:    separate record with type='refund'
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const { customer_payment_id, qb_bank_account_id } = req.body as {
    customer_payment_id: string;
    qb_bank_account_id: string;
  };

  if (!customer_payment_id || !qb_bank_account_id) {
    return res
      .status(400)
      .json({ error: "Missing customer_payment_id or qb_bank_account_id" });
  }

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
  if (payment.qb?.status === "yes") {
    return res.status(400).json({ error: "Already synced to QuickBooks" });
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

  if (DRY_RUN) {
    await writePipelineRow({
      referenceId: customer_payment_id,
      referenceType: "customer_payment",
      step: "write_check",
      status: "confirmed",
      qbTxnId: "DRY-RUN-CHECK-TXN",
      medusaRefNumber: refLabel,
    });
    return res.json({ success: true, dry_run: true });
  }

  // 5. Enqueue CheckAdd to bridge
  let enqueueRes: any;
  try {
    enqueueRes = await bridgeFetch("POST", "/api/sync/enqueue", {
      type: "check",
      action: "add",
      data: {
        AccountRef: { ListID: bank.list_id },
        PayeeEntityRef: { ListID: customerListId },
        RefNumber: refLabel,
        TxnDate: new Date().toISOString().split("T")[0],
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
    });
  } catch (e: any) {
    return res
      .status(500)
      .json({ error: `Bridge enqueue failed: ${e.message}` });
  }

  if (!enqueueRes?.operation_id) {
    return res
      .status(500)
      .json({ error: "Bridge did not return operation_id" });
  }

  // 6. Write pipeline row as submitted
  const writeCheckRowId = await writePipelineRow({
    referenceId: customer_payment_id,
    referenceType: "customer_payment",
    step: "write_check",
    status: "submitted",
    bridgeOpId: enqueueRes.operation_id,
    medusaRefNumber: medusaRef,
    payload: { bankAccountId: qb_bank_account_id },
  });

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
        }
      : { customerListId, originalPaymentTxnId, type: "direct_payment" },
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
  });
};
