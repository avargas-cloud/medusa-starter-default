import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { matchStatement } from "../../../../../../lib/banking/statement-matching";
import { bankFailure } from "../../../_lib/http";
import { reviewCommandRequest } from "../../../_lib/review-http";
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    const access = await reviewCommandRequest(req, "review");
    return res.json({
      ...(await matchStatement(
        access.id,
        access.actorId,
        access.key,
        req.body
      )),
      can_review: access.canReview,
      can_close: access.canClose,
    });
  } catch (error) {
    return bankFailure(res, error);
  }
}
