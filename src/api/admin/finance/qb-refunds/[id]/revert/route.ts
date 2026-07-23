import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { getDbPool } from "../../../../../utils/db-pool";
import { etDateString } from "../../../../../../lib/finance/batch-day";
import {
  performMedusaRefundRevert,
  skipOpenRefundPipelineRows,
} from "../../../../../../lib/finance/revert-refund";
import { isTreasuryDayLocked } from "../../../../../../lib/finance/treasury-lock";
import { verifySupervisorPin } from "../../../../../../lib/pos/verify-supervisor-pin";
import { writePipelineRow } from "../../../../../../lib/quickbooks/qb-pipeline";

const IN_FLIGHT = ["processing", "submitted"];

/**
 * POST /admin/finance/qb-refunds/:id/revert
 * Body: { supervisor_pin: string, reason: string }
 *
 * Reverts a recorded refund so the money returns to the customer as USABLE
 * CREDIT (unlike /void, which kills the credit). Three outcomes:
 *
 *  - mode 'reverted': nothing confirmed in QB → Medusa reverted immediately
 *    (any queued write_check/refund_payment rows are skipped first).
 *  - mode 'qb_cleanup_queued': QB Write Check confirmed AND the $0 apply
 *    ReceivePayment TxnID is known → enqueue refund_apply_del (TxnDel of the
 *    $0 apply — QB has no TxnVoid for ReceivePayment) chained to void_check
 *    (TxnVoid — the check stays as a $0 audit shell). The Medusa revert runs
 *    when refund_apply_del CONFIRMS — the moment QB actually frees the credit.
 *  - mode 'manual_qb_cleanup_required': check confirmed but the $0 apply
 *    TxnID is unknown (historic capture gap) → nothing is enqueued blindly;
 *    the accountant deletes the $0 ReceivePayment + voids the check in QB
 *    Desktop, then calls POST .../confirm-qb-cleanup to complete the revert.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const id = req.params.id as string;
  const { supervisor_pin, reason } = (req.body ?? {}) as {
    supervisor_pin?: string;
    reason?: string;
  };

  const knex = req.scope.resolve("__pg_connection__") as any;
  if (!(await verifySupervisorPin(knex, supervisor_pin))) {
    return res
      .status(403)
      .json({ error: "Invalid supervisor PIN", code: "INVALID_PIN" });
  }
  if (!reason || !reason.trim()) {
    return res
      .status(400)
      .json({ error: "A reason is required", code: "REASON_REQUIRED" });
  }

  const pool = getDbPool();
  const { rows } = await pool.query(
    `SELECT id, type, status, amount, reference, display_id, batch_day,
            COALESCE(metadata, '{}'::jsonb) AS metadata,
            COALESCE(qb, '{}'::jsonb) AS qb
       FROM customer_payment
      WHERE id = $1 AND deleted_at IS NULL`,
    [id]
  );
  const payment = rows[0];
  if (!payment) {
    return res.status(404).json({ error: "CustomerPayment not found" });
  }
  if (payment.type === "refund") {
    return res.status(400).json({
      error: "Legacy refund records cannot be reverted from here",
      code: "LEGACY_UNSUPPORTED",
    });
  }
  if (!["refunded", "partial_refunded"].includes(payment.status)) {
    return res.status(400).json({
      error: `Payment is not a refund (status=${payment.status})`,
      code: "NOT_REFUNDED",
    });
  }

  const meta = payment.metadata as Record<string, unknown>;
  if (meta.terminal_refunded === true) {
    return res.status(409).json({
      error:
        "This refund was already executed on the card terminal — the money left. Reverting the ledger is not allowed.",
      code: "REFUND_ALREADY_EXECUTED",
    });
  }
  if (meta.revert_state) {
    return res.status(409).json({
      error: `A revert is already in progress (${String(meta.revert_state)})`,
      code: "REVERT_ALREADY_PENDING",
    });
  }

  // Treasury Confirm & Lock guard: the refund's recorded day AND today must
  // both be open — a revert moves money between those two days' numbers.
  const refundDay =
    (meta.refund_txn_date as string | undefined) ?? payment.batch_day ?? null;
  const today = etDateString(new Date());
  for (const day of [refundDay, today]) {
    if (day && (await isTreasuryDayLocked(day))) {
      return res.status(409).json({
        error: `Treasury day ${day} is confirmed & locked — unlock it or handle as an accounting adjustment.`,
        code: "TREASURY_DAY_LOCKED",
        day,
      });
    }
  }

  // Pipeline state (latest row per step)
  const { rows: pipeRows } = await pool.query(
    `SELECT DISTINCT ON (step) step, id, status, qb_txn_id
       FROM qb_order_pipeline
      WHERE reference_id = $1
        AND step IN ('write_check', 'refund_payment', 'refund_check_mod',
                     'refund_payment_txndate_change')
      ORDER BY step, COALESCE(updated_at, created_at) DESC`,
    [id]
  );
  const byStep: Record<string, { id: string; status: string; qb_txn_id: string | null }> = {};
  for (const r of pipeRows) byStep[r.step] = r;

  for (const modStep of ["refund_check_mod", "refund_payment_txndate_change"]) {
    if (IN_FLIGHT.includes(byStep[modStep]?.status ?? "")) {
      return res.status(409).json({
        error: "A QB edit for this refund is still in flight — wait for it to confirm, then revert.",
        code: "EDIT_IN_FLIGHT",
      });
    }
  }

  const qb = payment.qb as Record<string, unknown>;
  const checkTxnId = (qb.check_txn_id as string | undefined) ?? null;
  const checkConfirmed = qb.status === "yes" && !!checkTxnId;
  const wc = byStep["write_check"];
  const actorId = (req as any).auth_context?.actor_id ?? null;
  const label = payment.display_id ? `PAY-${payment.display_id}` : id;

  // ── EASY: no confirmed check in QB ─────────────────────────────────────────
  if (!checkConfirmed) {
    if (wc && [...IN_FLIGHT, "confirmed"].includes(wc.status)) {
      // 'confirmed' row with qb.status not yet 'yes' = poller about to land it.
      return res.status(409).json({
        error: "The QB Write Check is in flight — wait ~2 min for it to confirm, then revert.",
        code: "WRITE_CHECK_IN_FLIGHT",
      });
    }
    await skipOpenRefundPipelineRows(
      id,
      ["write_check", "refund_payment"],
      `refund reverted to credit (${reason.trim()})`
    );
    const out = await performMedusaRefundRevert(id, {
      reason: reason.trim(),
      actorId,
      source: "immediate",
    });
    if (!out.ok) {
      return res.status(409).json({ error: "Revert failed", code: out.code });
    }
    return res.json({
      success: true,
      mode: "reverted",
      new_status: out.newStatus,
      restored_cents: out.restoredCents,
    });
  }

  // ── MEDIUM: check confirmed in QB ──────────────────────────────────────────
  const rp = byStep["refund_payment"];
  if (IN_FLIGHT.includes(rp?.status ?? "")) {
    return res.status(409).json({
      error: "The $0 apply payment is in flight to QB — wait for it to confirm, then revert.",
      code: "REFUND_PAYMENT_IN_FLIGHT",
    });
  }

  const stampRevertState = async (state: string) => {
    await pool.query(
      `UPDATE customer_payment
          SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
              updated_at = NOW()
        WHERE id = $1`,
      [
        id,
        JSON.stringify({
          revert_state: state,
          revert_reason: reason.trim(),
          revert_requested_by: actorId,
          revert_requested_at: new Date().toISOString(),
        }),
      ]
    );
  };

  // $0 apply never reached QB (waiting/failed/absent-but-unconfirmed) → the
  // credit was never consumed in QB. Skip the row, revert now, void the check.
  const rpConfirmed = rp?.status === "confirmed";
  if (rp && !rpConfirmed) {
    await skipOpenRefundPipelineRows(
      id,
      ["refund_payment"],
      `refund reverted to credit (${reason.trim()})`
    );
    await writePipelineRow({
      referenceId: id,
      referenceType: "customer_payment",
      step: "void_check",
      status: "pending",
      qbTxnId: checkTxnId,
      medusaRefNumber: `Revert ${label}`,
    });
    const out = await performMedusaRefundRevert(id, {
      reason: reason.trim(),
      actorId,
      source: "immediate",
    });
    if (!out.ok) {
      return res.status(409).json({ error: "Revert failed", code: out.code });
    }
    return res.json({
      success: true,
      mode: "reverted",
      new_status: out.newStatus,
      restored_cents: out.restoredCents,
      check_void_queued: true,
    });
  }

  // Automatic cleanup: delete the $0 apply FIRST (frees the credit in QB),
  // then TxnVoid the check. The Medusa revert happens when refund_apply_del
  // confirms — or when void_check confirms, for the no-doc case below —
  // never before QB frees the credit.
  //
  // When the $0 apply TxnID is unknown (the historic norm — QB's AddRs Ret
  // for a zero-amount credit apply carries no TxnID), the refund_apply_del
  // row resolves it at dispatch time from the CHECK's LinkedTxns:
  //  - linked ReceivePayment found → that's the doc, TxnDel it;
  //  - none linked → no $0 doc exists → row skips itself, void_check alone
  //    frees the credit;
  //  - bridge without IncludeLinkedTxns → row retry-fails with a clear
  //    message; manual escape hatch = POST .../confirm-qb-cleanup.
  const applyTxnId = rp?.qb_txn_id || null;
  await stampRevertState("pending_qb_cleanup");
  const delRowId = await writePipelineRow({
    referenceId: id,
    referenceType: "customer_payment",
    step: "refund_apply_del",
    status: "pending",
    qbTxnId: applyTxnId,
    medusaRefNumber: `Revert ${label}`,
    ...(applyTxnId
      ? {}
      : {
          payload: {
            resolveVia: "check_linked_txn",
            checkTxnId,
          },
        }),
  });
  await writePipelineRow({
    referenceId: id,
    referenceType: "customer_payment",
    step: "void_check",
    status: "waiting",
    dependsOn: delRowId,
    qbTxnId: checkTxnId,
    medusaRefNumber: `Revert ${label}`,
  });
  return res.status(202).json({
    success: true,
    mode: "qb_cleanup_queued",
    check_txn_id: checkTxnId,
    apply_txn_resolution: applyTxnId ? "known" : "resolve_from_check",
  });
};
