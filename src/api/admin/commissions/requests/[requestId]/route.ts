/**
 * POST /admin/commissions/requests/:requestId — `{ action: "reject", reason }`.
 * Accounting + PIN de supervisor (`x-supervisor-pin`, guard con throttle —
 * nunca `verifySupervisorPin` pelado). La APROBACIÓN no pasa por acá: es
 * automática al guardar la asignación con esa identidad como beneficiario
 * (`resolveRequestsForAssignment` en POST /admin/commissions/orders/:orderId),
 * que ya lleva su propio PIN (commission-requests-20260917).
 */

import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { getDbPool } from "../../../../utils/db-pool";
import { withOrderCommissionLock } from "../../../../../lib/commissions/writer";
import {
  CommissionRequestError,
  getRequest,
  rejectRequest,
  requestErrorStatus,
} from "../../../../../lib/commissions/requests";
import { assertAccounting, requireSupervisorPin } from "../../_lib/guard";

const REASON_MAX = 500;

export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> {
  if (!(await assertAccounting(req, res))) return;
  const requestId = req.params.requestId;
  if (!requestId) {
    res.status(400).json({ error: "requestId is required." });
    return;
  }
  const body = (req.body ?? {}) as { action?: unknown; reason?: unknown };
  if (body.action !== "reject") {
    res.status(400).json({ error: "action must be 'reject'." });
    return;
  }
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason || reason.length > REASON_MAX) {
    res.status(400).json({ error: `reason is required (max ${REASON_MAX} chars).` });
    return;
  }
  const pin = await requireSupervisorPin(req, res);
  if (!pin) return;

  const pool = getDbPool();
  try {
    const existing = await getRequest(pool, requestId);
    if (!existing) throw new CommissionRequestError("not_found", "Request not found.");
    await withOrderCommissionLock(pool, existing.order_id, (client) =>
      rejectRequest(client, requestId, reason, pin.actorId)
    );
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof CommissionRequestError) {
      res.status(requestErrorStatus(err)).json({ error: err.message, code: err.code });
      return;
    }
    console.error("[commission-requests] reject failed:", err);
    res.status(500).json({ error: "Could not reject the commission request." });
  }
}
