import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";
import { listReviewPermissions, reviewAccess, saveReviewPermission } from "../../../../lib/banking/review-permissions";
import { bankBody, bankFailure, bankId } from "../_lib/http";
import { reviewKey } from "../_lib/review-http";
import { pinGuardFailure, pinGuardInput } from "../_lib/pin";
import { guardSupervisorPin } from "../../../../lib/pos/supervisor-pin-guard";
const bodySchema = z.object({ user_id: bankId, can_review: z.boolean(), can_close: z.boolean(), can_post: z.boolean().optional() }).strict();
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try {
    await reviewAccess(req, "manage");
    return res.json(await listReviewPermissions());
  } catch (error) { return bankFailure(res, error); }
}
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try {
    const { actorId } = await reviewAccess(req, "manage");
    // El permiso dice QUIÉN puede administrar; el PIN autoriza el CAMBIO.
    const guard = await guardSupervisorPin(pinGuardInput(req));
    if (!guard.ok) return pinGuardFailure(res, guard);
    return res.json(await saveReviewPermission(actorId, reviewKey(req), bankBody(bodySchema, req.body)));
  } catch (error) { return bankFailure(res, error); }
}
