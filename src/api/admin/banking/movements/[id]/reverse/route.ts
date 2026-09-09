import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { reverseMovement } from "../../../../../../lib/banking/movement-core";
import { movementReverseSchema } from "../../../../../../lib/banking/movement-types";
import { bankBody, bankFailure } from "../../../_lib/http";
import { reviewCommandRequest } from "../../../_lib/review-http";
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try { const access = await reviewCommandRequest(req, "post");
    return res.json({ ...await reverseMovement(access.id, access.actorId, access.key, bankBody(movementReverseSchema, req.body)),
      can_post: access.canPost, can_review: access.canReview }); }
  catch (error) { return bankFailure(res, error); }
}
