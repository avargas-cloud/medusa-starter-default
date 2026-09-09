import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { postMovement } from "../../../../../../lib/banking/movement-core";
import { movementReceiveSchema } from "../../../../../../lib/banking/movement-types";
import { bankBody, bankFailure } from "../../../_lib/http";
import { reviewCommandRequest } from "../../../_lib/review-http";
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    const access = await reviewCommandRequest(req, "post");
    return res.json({
      ...(await postMovement(
        access.id,
        access.actorId,
        access.key,
        bankBody(movementReceiveSchema, req.body),
        true
      )),
      can_post: access.canPost,
      can_review: access.canReview,
    });
  } catch (error) {
    return bankFailure(res, error);
  }
}
