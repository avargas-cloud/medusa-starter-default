import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { listMovements } from "../../../../lib/banking/movement-read";
import { saveMovement } from "../../../../lib/banking/movement-core";
import { movementSaveSchema } from "../../../../lib/banking/movement-types";
import { reviewAccess } from "../../../../lib/banking/review-permissions";
import { bankBody, bankFailure } from "../_lib/http";
import { reviewKey } from "../_lib/review-http";
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try { const access = await reviewAccess(req); return res.json({ ...await listMovements(), can_post: access.canPost, can_review: access.canReview }); }
  catch (error) { return bankFailure(res, error); }
}
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try { const access = await reviewAccess(req, "review"); return res.json({ ...await saveMovement(access.actorId, reviewKey(req),
    bankBody(movementSaveSchema, req.body)), can_post: access.canPost, can_review: access.canReview }); }
  catch (error) { return bankFailure(res, error); }
}
