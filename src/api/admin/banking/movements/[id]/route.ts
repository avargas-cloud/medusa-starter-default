import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { readMovement } from "../../../../../lib/banking/movement-read";
import { reviewAccess } from "../../../../../lib/banking/review-permissions";
import { bankBody, bankId, bankFailure } from "../../_lib/http";
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    const access = await reviewAccess(req);
    return res.json({
      ...(await readMovement(bankBody(bankId, req.params.id))),
      can_post: access.canPost,
      can_review: access.canReview,
    });
  } catch (error) {
    return bankFailure(res, error);
  }
}
