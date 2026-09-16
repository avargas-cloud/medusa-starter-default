import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import type { PoolClient } from "pg";
import { getDbPool } from "../../../../../../utils/db-pool";
import {
  extractSupervisorPin,
  guardSupervisorPin,
  pinGuardResponse,
  resolveActorId,
} from "../../../../../../../lib/pos/supervisor-pin-guard";
import type { PinConn } from "../../../../../../../lib/pos/verify-supervisor-pin";
import { runLedgerHook } from "../../../../../../../lib/ledger-hooks/run-ledger-hook";
import { reverseVendorBillAdjustment } from "../../../../../../../lib/ledger/documents/vendor-bill-adjustment";
import {
  voidVendorBillAdjustment,
  VendorBillAdjustmentError,
} from "../../../../../../../lib/vendor-bill-adjustments/create";

/**
 * POST /admin/vendor-bills/:id/adjustments/:adjustmentId/void { reason }
 * Supervisor PIN required. Reverses the GL entry on the void day; the bill's
 * residual comes back (ap-rounding-cleanup-20260916).
 */
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id, adjustmentId } = req.params as {
    id: string;
    adjustmentId: string;
  };
  const actorId = resolveActorId(req);
  const knex = req.scope.resolve("__pg_connection__");
  const guard = await guardSupervisorPin({
    scope: req.scope as unknown as { resolve: (k: string) => unknown },
    db: knex as unknown as PinConn,
    pin: extractSupervisorPin(req),
    actorId,
  });
  if (!guard.ok) {
    const { status, body } = pinGuardResponse(guard);
    return res.status(status).json(body);
  }
  const body = (req.body ?? {}) as { reason?: unknown };
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 5) {
    return res
      .status(400)
      .json({
        error: "Provide a reason (min 5 characters).",
        code: "invalid_body",
      });
  }

  const client: PoolClient = await getDbPool().connect();
  try {
    await client.query("BEGIN");
    const row = await voidVendorBillAdjustment(
      client,
      adjustmentId,
      reason,
      actorId
    );
    if (row.vendor_bill_id !== id) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({
          error: "Adjustment does not belong to this bill.",
          code: "not_found",
        });
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof VendorBillAdjustmentError) {
      return res
        .status(error.status)
        .json({ error: error.message, code: error.code });
    }
    throw error;
  } finally {
    client.release();
  }

  await runLedgerHook(
    (c) => reverseVendorBillAdjustment(c, adjustmentId, actorId, reason),
    {
      source_kind: "vendor_bill_adjustment",
      source_id: adjustmentId,
    }
  );
  return res.json({ id: adjustmentId, voided: true });
}
