import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { closeStatement } from "../../../../../../lib/banking/statement-core";
import { reviewCommandRequest } from "../../../_lib/review-http";
import { bankFailure } from "../../../_lib/http";
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try { const access = await reviewCommandRequest(req, "close");
    return res.json({ ...await closeStatement(access.id, access.actorId, access.key, req.body),
      can_review: access.canReview, can_close: access.canClose }); } catch (error) { return bankFailure(res, error); }
}
