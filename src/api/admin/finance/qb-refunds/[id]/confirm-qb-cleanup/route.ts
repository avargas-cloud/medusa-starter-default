import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { getDbPool } from "../../../../../utils/db-pool";
import {
  performMedusaRefundRevert,
  skipOpenRefundPipelineRows,
} from "../../../../../../lib/finance/revert-refund";
import { verifySupervisorPin } from "../../../../../../lib/pos/verify-supervisor-pin";

/**
 * POST /admin/finance/qb-refunds/:id/confirm-qb-cleanup
 * Body: { supervisor_pin: string }
 *
 * Completes a revert that was parked in 'pending_manual_qb_cleanup' (the $0
 * apply TxnID was unknown → the accountant deleted the $0 ReceivePayment and
 * voided the Write Check by hand in QB Desktop), and doubles as the escape
 * hatch for a stuck 'pending_qb_cleanup' (auto path wedged — e.g. QB rejects
 * the TxnDel because the doc is open on screen) after manual cleanup.
 *
 * This is an ATTESTATION: the caller asserts QB is clean. It skips any open
 * refund_apply_del/void_check rows (so the pipeline never re-deletes), runs
 * the Medusa revert, and stamps qb.status='voided'.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const id = req.params.id as string;
  const { supervisor_pin } = (req.body ?? {}) as { supervisor_pin?: string };

  const knex = req.scope.resolve("__pg_connection__") as any;
  if (!(await verifySupervisorPin(knex, supervisor_pin))) {
    return res
      .status(403)
      .json({ error: "Invalid supervisor PIN", code: "INVALID_PIN" });
  }

  const pool = getDbPool();
  const { rows } = await pool.query(
    `SELECT id, status,
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

  const revertState = (payment.metadata as Record<string, unknown>)
    .revert_state as string | undefined;
  if (
    revertState !== "pending_manual_qb_cleanup" &&
    revertState !== "pending_qb_cleanup"
  ) {
    return res.status(409).json({
      error: "No pending QB cleanup for this refund",
      code: "NO_PENDING_CLEANUP",
    });
  }

  // Stop the pipeline from re-touching QB docs the accountant already removed.
  await skipOpenRefundPipelineRows(
    id,
    ["refund_apply_del", "void_check"],
    "manual QB cleanup attested via confirm-qb-cleanup"
  );

  const actorId = (req as any).auth_context?.actor_id ?? null;
  const out = await performMedusaRefundRevert(id, {
    actorId,
    source: "manual_cleanup_attested",
    reason: null, // reason was staged at revert time (metadata.revert_reason)
  });
  if (!out.ok) {
    return res.status(409).json({ error: "Revert failed", code: out.code });
  }

  // qb.status='voided' — same terminal marker the void_check confirm handler
  // writes; keeps check_txn_id as the audit pointer to the voided shell.
  await pool.query(
    `UPDATE customer_payment
        SET qb = COALESCE(qb, '{}'::jsonb) || '{"status":"voided"}'::jsonb,
            updated_at = NOW()
      WHERE id = $1`,
    [id]
  );

  return res.json({
    success: true,
    mode: "reverted",
    new_status: out.newStatus,
    restored_cents: out.restoredCents,
  });
};
