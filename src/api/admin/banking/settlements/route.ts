import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { reviewAccess } from "../../../../lib/banking/review-permissions";
import { saveSettlement } from "../../../../lib/banking/settlement-core";
import { listSettlements } from "../../../../lib/banking/settlement-read";
import { settlementSaveSchema } from "../../../../lib/banking/settlement-types";
import { bankBody, bankFailure } from "../_lib/http";
import { reviewKey } from "../_lib/review-http";
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    const access = await reviewAccess(req);
    return res.json({
      ...(await listSettlements()),
      can_post: access.canPost,
      can_review: access.canReview,
    });
  } catch (error) {
    return bankFailure(res, error);
  }
}
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    const access = await reviewAccess(req, "review");
    return res.json({
      ...(await saveSettlement(
        access.actorId,
        reviewKey(req),
        bankBody(settlementSaveSchema, req.body)
      )),
      can_post: access.canPost,
      can_review: access.canReview,
    });
  } catch (error) {
    return bankFailure(res, error);
  }
}
