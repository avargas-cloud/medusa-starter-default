import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { previewMovement } from "../../../../../../lib/banking/movement-core";
import { movementPreviewSchema } from "../../../../../../lib/banking/movement-types";
import { bankBody, bankFailure } from "../../../_lib/http";
import { reviewCommandRequest } from "../../../_lib/review-http";
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try { const access = await reviewCommandRequest(req, "post");
    return res.json({ ...await previewMovement(access.id, access.actorId, access.key, bankBody(movementPreviewSchema, req.body)),
      can_post: access.canPost, can_review: access.canReview }); }
  catch (error) { return bankFailure(res, error); }
}
