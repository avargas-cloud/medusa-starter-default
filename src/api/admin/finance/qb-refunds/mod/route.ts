import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { writePipelineRow } from "../../../../../lib/quickbooks/qb-pipeline";
import { FINANCE_MODULE } from "../../../../../modules/finance";

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * POST /admin/finance/qb-refunds/mod
 * Edits an ALREADY-CONFIRMED refund in QuickBooks: bank account and/or refund
 * date. Body: { customer_payment_id, refund_date?, qb_bank_account_id? } (at
 * least one of the two changes).
 *
 * Enqueue-only (Section 1.5.14 — no direct bridge call):
 *  - date and/or bank → 'refund_check_mod' row (consolidator issues a
 *    header-only CheckMod; fresh EditSequence per dispatch). The confirmed
 *    write_check row's payload is updated only AFTER the mod confirms
 *    (poll-submitted-rows) so the UI never claims a bank QB hasn't accepted.
 *  - date, when the $0 apply ReceivePayment is already confirmed →
 *    'refund_payment_txndate_change' row (ReceivePaymentMod, date only).
 *  - date, when the refund_payment row is still waiting → its payload.txnDate
 *    is rewritten in place (it will dispatch with the new date; no mod needed).
 *
 * The desired values are read LIVE at dispatch (batch_day/metadata for the
 * date; the mod row's payload for the bank), so repeated edits coalesce into
 * the latest value — same convergence model as payment_txndate_change.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const { customer_payment_id, refund_date, qb_bank_account_id } = req.body as {
    customer_payment_id: string;
    refund_date?: string;
    qb_bank_account_id?: string;
  };

  if (!customer_payment_id) {
    return res.status(400).json({ error: "Missing customer_payment_id" });
  }
  if (!refund_date && !qb_bank_account_id) {
    return res.status(400).json({
      error: "Provide refund_date and/or qb_bank_account_id",
      code: "NOTHING_TO_CHANGE",
    });
  }
  if (refund_date !== undefined && !DATE_ONLY_RE.test(refund_date)) {
    return res
      .status(400)
      .json({ error: "refund_date must be YYYY-MM-DD", code: "BAD_DATE" });
  }

  const financeService = req.scope.resolve(FINANCE_MODULE);
  const pgConnection = req.scope.resolve("__pg_connection__") as any;

  // 1. Payment must be a non-voided refund
  const payments = await financeService.listCustomerPayments({
    id: customer_payment_id,
  } as any);
  const payment = (payments as any[])[0];
  if (!payment)
    return res.status(404).json({ error: "CustomerPayment not found" });
  const isRefund =
    payment.type === "refund" ||
    ["refunded", "partial_refunded"].includes(payment.status as string);
  if (!isRefund) {
    return res.status(400).json({ error: "Payment is not a refund" });
  }
  if (payment.status === "voided") {
    return res.status(400).json({ error: "Refund is voided" });
  }

  // 2. The QB Write Check must be CONFIRMED (else edits belong to the create
  //    flow: pending → just re-run sync; in flight → wait).
  const { rows: wcRows } = await pgConnection.raw(
    `SELECT id, status, qb_txn_id FROM qb_order_pipeline
      WHERE step = 'write_check' AND reference_id = ?
      ORDER BY COALESCE(updated_at, created_at) DESC
      LIMIT 1`,
    [customer_payment_id]
  );
  const wc = wcRows?.[0] as
    | { id: string; status: string; qb_txn_id: string | null }
    | undefined;
  if (!wc || wc.status !== "confirmed" || !wc.qb_txn_id) {
    return res.status(409).json({
      error:
        "The QB Write Check is not confirmed yet — the refund date/bank can only be edited after it lands in QuickBooks. Use the process flow instead.",
      code: "WRITE_CHECK_NOT_CONFIRMED",
    });
  }

  // 3. Bank (if changing): must exist and be a Bank account
  if (qb_bank_account_id) {
    const banks = await financeService.listQbBankAccounts({
      id: qb_bank_account_id,
    } as any);
    const bank = (banks as any[])[0];
    if (!bank)
      return res.status(404).json({ error: "Bank account not found" });
    if (bank.type !== "Bank") {
      return res.status(400).json({
        error: `Selected account "${bank.name}" is type "${bank.type}", not a Bank account.`,
      });
    }
  }

  // 4. Persist the new date as the canonical desired state (read live at
  //    dispatch). received_at stays untouched ("Credit Memo Date").
  if (refund_date) {
    const newMeta = {
      ...((payment.metadata as Record<string, unknown>) ?? {}),
      refund_txn_date: refund_date,
    };
    // batch_day is a TEXT day-key column ('YYYY-MM-DD'), not DATE
    await pgConnection.raw(
      `UPDATE customer_payment
          SET batch_day = ?, metadata = ?::jsonb
        WHERE id = ?`,
      [refund_date, JSON.stringify(newMeta), customer_payment_id]
    );
  }

  // 5. Enqueue the CheckMod row. Coalescing: if one is already active, update
  //    its payload (latest bank wins) instead of stacking a second mod.
  const modPayload: Record<string, unknown> = {};
  if (qb_bank_account_id) modPayload.bankAccountId = qb_bank_account_id;

  const { rows: activeMod } = await pgConnection.raw(
    `SELECT id, status FROM qb_order_pipeline
      WHERE step = 'refund_check_mod' AND reference_id = ?
        AND status IN ('pending', 'processing', 'submitted')
      ORDER BY COALESCE(updated_at, created_at) DESC
      LIMIT 1`,
    [customer_payment_id]
  );
  let checkModRowId: string;
  if (activeMod?.[0]) {
    checkModRowId = activeMod[0].id as string;
    if (qb_bank_account_id) {
      await pgConnection.raw(
        `UPDATE qb_order_pipeline
            SET payload = COALESCE(payload, '{}'::jsonb) || ?::jsonb,
                updated_at = NOW()
          WHERE id = ?`,
        [JSON.stringify({ bankAccountId: qb_bank_account_id }), checkModRowId]
      );
    }
  } else {
    checkModRowId = await writePipelineRow({
      referenceId: customer_payment_id,
      referenceType: "customer_payment",
      step: "refund_check_mod",
      status: "pending",
      qbTxnId: wc.qb_txn_id,
      medusaRefNumber: `Refund edit ${payment.reference ?? customer_payment_id.slice(-8)}`,
      payload: modPayload,
    });
  }

  // 6. Move the $0 apply ReceivePayment's date too (both QB docs must carry
  //    the refund date).
  let applyDateQueued = false;
  if (refund_date) {
    const { rows: rpRows } = await pgConnection.raw(
      `SELECT id, status, qb_txn_id FROM qb_order_pipeline
        WHERE step = 'refund_payment' AND reference_id = ?
        ORDER BY COALESCE(updated_at, created_at) DESC
        LIMIT 1`,
      [customer_payment_id]
    );
    const rp = rpRows?.[0] as
      | { id: string; status: string; qb_txn_id: string | null }
      | undefined;
    if (rp?.status === "waiting") {
      // Not in QB yet — it will be created with the new date.
      await pgConnection.raw(
        `UPDATE qb_order_pipeline
            SET payload = COALESCE(payload, '{}'::jsonb) || ?::jsonb,
                updated_at = NOW()
          WHERE id = ?`,
        [JSON.stringify({ txnDate: refund_date }), rp.id]
      );
    } else if (rp) {
      // Confirmed → ReceivePaymentMod. Submitted/processing → the dispatch
      // handler re-reads the live row and fails-retryable until it confirms,
      // so enqueueing now is safe (no race with the in-flight create).
      const { rows: activeRpMod } = await pgConnection.raw(
        `SELECT id FROM qb_order_pipeline
          WHERE step = 'refund_payment_txndate_change' AND reference_id = ?
            AND status IN ('pending', 'processing', 'submitted')
          LIMIT 1`,
        [customer_payment_id]
      );
      if (!activeRpMod?.[0]) {
        await writePipelineRow({
          referenceId: customer_payment_id,
          referenceType: "customer_payment",
          step: "refund_payment_txndate_change",
          status: "pending",
          qbTxnId: rp.qb_txn_id ?? undefined,
          medusaRefNumber: `Refund apply date ${payment.reference ?? customer_payment_id.slice(-8)}`,
        });
      }
      applyDateQueued = true;
    }
  }

  return res.json({
    success: true,
    queued: true,
    check_mod_row_id: checkModRowId,
    apply_date_queued: applyDateQueued,
    refund_date: refund_date ?? null,
  });
};
