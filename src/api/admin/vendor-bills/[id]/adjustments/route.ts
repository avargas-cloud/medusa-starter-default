import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import type { PoolClient } from "pg";
import { getDbPool } from "../../../../utils/db-pool";
import {
  extractSupervisorPin,
  guardSupervisorPin,
  pinGuardResponse,
  resolveActorId,
} from "../../../../../lib/pos/supervisor-pin-guard";
import type { PinConn } from "../../../../../lib/pos/verify-supervisor-pin";
import { runLedgerHook } from "../../../../../lib/ledger-hooks/run-ledger-hook";
import { postVendorBillAdjustment } from "../../../../../lib/ledger/documents/vendor-bill-adjustment";
import { bankingErrorResponse } from "../../../../../lib/accounting/banking-error-http";
import {
  createVendorBillAdjustment,
  listVendorBillAdjustments,
  VendorBillAdjustmentError,
} from "../../../../../lib/vendor-bill-adjustments/create";
import { getBusinessDateString } from "../../../../../lib/date/et";

/**
 * ap-rounding-cleanup-20260916
 *
 * GET  /admin/vendor-bills/:id/adjustments → { adjustments }
 * POST /admin/vendor-bills/:id/adjustments
 *      { kind: 'rounding'|'price_variance', residual_cents, adjustment_date?, memo? }
 *      Supervisor PIN required (`x-supervisor-pin`): this WRITES money — it
 *      lowers or raises what the POS says is owed to a vendor. `rounding`
 *      above the tolerance is refused (422) even with a PIN; a bigger residual
 *      is a `price_variance` and has to be called that.
 */
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id } = req.params as { id: string };
  const client = await getDbPool().connect();
  try {
    const adjustments = await listVendorBillAdjustments(client, id);
    return res.json({ adjustments });
  } finally {
    client.release();
  }
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id } = req.params as { id: string };
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

  const body = (req.body ?? {}) as {
    kind?: unknown;
    residual_cents?: unknown;
    adjustment_date?: unknown;
    memo?: unknown;
  };
  const kind =
    body.kind === "rounding" || body.kind === "price_variance"
      ? body.kind
      : null;
  const residual =
    typeof body.residual_cents === "number" ? body.residual_cents : NaN;
  if (!kind || !Number.isInteger(residual) || residual === 0) {
    return res.status(400).json({
      error:
        "kind (rounding|price_variance) and a non-zero integer residual_cents are required.",
      code: "invalid_body",
    });
  }
  const adjustmentDate =
    typeof body.adjustment_date === "string" && body.adjustment_date
      ? body.adjustment_date
      : getBusinessDateString();

  const client: PoolClient = await getDbPool().connect();
  let created: Awaited<ReturnType<typeof createVendorBillAdjustment>>;
  try {
    await client.query("BEGIN");
    created = await createVendorBillAdjustment(client, {
      vendor_bill_id: id,
      kind,
      residual_cents: residual,
      adjustment_date: adjustmentDate,
      source_fingerprint: `manual:${actorId}:${adjustmentDate}:${residual}`,
      evidence: { via: guard.via, route: "vendor-bills/:id/adjustments" },
      memo: typeof body.memo === "string" ? body.memo : null,
      actor_id: actorId,
      ignore_tolerance: kind === "price_variance",
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof VendorBillAdjustmentError) {
      return res
        .status(error.status)
        .json({ error: error.message, code: error.code });
    }
    const banking = bankingErrorResponse(res, error);
    if (banking) return banking;
    throw error;
  } finally {
    client.release();
  }

  if (created.created) {
    await runLedgerHook(
      (c) => postVendorBillAdjustment(c, created.adjustment.id, actorId),
      {
        source_kind: "vendor_bill_adjustment",
        source_id: created.adjustment.id,
      }
    );
  }
  return res
    .status(created.created ? 201 : 200)
    .json({ adjustment: created.adjustment, created: created.created });
}
