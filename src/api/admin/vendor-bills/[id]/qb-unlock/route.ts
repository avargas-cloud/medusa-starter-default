/**
 * POST /admin/vendor-bills/:id/qb-unlock
 *
 * Prepares the destructive half of a reviewed Bill rebuild. This route only
 * freezes two universal purchase-chain operations (PIN + guards):
 * BillQuery preflight -> TxnDel Bill. The consolidator is the only bridge
 * caller. After TxnDel confirms, the bill remains a local `rebuild_ready`
 * draft until the operator Reconfirms it; only then is a fresh BillAdd queued
 * in the same accounting transaction.
 *
 * Body: { supervisor_pin: string, reason: string }
 *
 * 202 { status: 'rebuild_queued', ...operation ids } on success. 409 with one
 * of `bill_not_synced` / `bill_rebuild_not_required` /
 * `unlock_already_in_flight` (see `claimUnlock`); 404 `bill_not_found`; 403
 * `invalid_supervisor_pin`; 400 `validation_error`.
 *
 * `china_agent_unlock_blocked` is gone (2026-08-04): a China-agent bill with a
 * new PO-linked line had no path at all, since BillMod cannot create PO links
 * either. See `claimUnlock` for what still guards the delete.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

import { getActorUserId, UnauthenticatedError } from "../../../purchase-orders/_lib/auth";
import { zodErrorToBody } from "../../../purchase-orders/_lib/format";
import { verifySupervisorPin } from "../../../../../lib/pos/verify-supervisor-pin";
import { claimUnlock, type UnlockKnex } from "../../../../../lib/purchase-orders/qb-vendor-bill-unlock";

function resolveKnex(req: AuthenticatedMedusaRequest): UnlockKnex {
  return (req.scope as unknown as { resolve: (k: string) => unknown }).resolve(
    "__pg_connection__"
  ) as UnlockKnex;
}

const bodySchema = z.object({
  supervisor_pin: z.string().min(1, "PIN required"),
  reason: z.string().trim().min(1, "Reason required").max(500),
});

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  let userId: string;
  try {
    userId = getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    throw err as Error;
  }

  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }

  const { id } = req.params as { id: string };
  const knex = resolveKnex(req);

  const pinOk = await verifySupervisorPin(knex, parsed.data.supervisor_pin);
  if (!pinOk) {
    return res.status(403).json({
      error: "Invalid supervisor PIN",
      code: "invalid_supervisor_pin",
    });
  }

  const result = await claimUnlock(knex, id, {
    reason: parsed.data.reason,
    actorId: userId,
  });

  if (!result.ok) {
    const status = result.code === "bill_not_found" ? 404 : 409;
    return res.status(status).json({ error: result.message, code: result.code });
  }

  return res.status(202).json({
    status: "rebuild_queued",
    pipeline_row_id: result.pipelineRowId,
    preflight_operation_id: result.preflightOperationId,
    delete_operation_id: result.deleteOperationId,
  });
}
