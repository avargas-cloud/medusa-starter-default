/**
 * POST /admin/vendor-bills/:id/qb-unlock
 *
 * Item 1.9 (`docs/VENDOR_BILL_QB_SYNC_PLAN.md` §6.2/§9 — SIMPLIFIED MVP,
 * Fable design decision 2026-07-23). Unlock = delete-then-re-add BEHIND THE
 * EXISTING DISPATCH GATES: this route only claims the pipeline row (PIN +
 * guards), it never talks to the bridge directly — `qb-vendor-bill-poller.ts`
 * Phase D does the BillQuery preflight, `TxnDel Bill`, and re-`BillAdd`.
 *
 * Body: { supervisor_pin: string, reason: string }
 *
 * 202 { status: 'unlock_queued', pipeline_row_id } on success. 409 with one
 * of `bill_not_synced` / `china_agent_unlock_blocked` /
 * `unlock_already_in_flight` (see `claimUnlock`); 404 `bill_not_found`; 403
 * `invalid_supervisor_pin`; 400 `validation_error`.
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
    status: "unlock_queued",
    pipeline_row_id: result.pipelineRowId,
  });
}
