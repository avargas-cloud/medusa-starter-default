import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { listOpeningClearCandidates } from "../../../../../../../../lib/banking/opening-clear";
import { reviewAccess } from "../../../../../../../../lib/banking/review-permissions";
import { bankBody, bankFailure, bankId } from "../../../../../_lib/http";
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    const { canPost } = await reviewAccess(req);
    return res.json({
      ...(await listOpeningClearCandidates(bankBody(bankId, req.params.id))),
      can_post: canPost,
    });
  } catch (error) {
    return bankFailure(res, error);
  }
}
