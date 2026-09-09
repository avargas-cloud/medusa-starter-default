import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { addOpeningEvidence } from "../../../../../../lib/banking/opening-evidence";
import { openingEvidenceSchema } from "../../../../../../lib/banking/opening-types";
import { reviewAccess } from "../../../../../../lib/banking/review-permissions";
import { bankBody, bankFailure } from "../../../_lib/http";
import { reviewKey } from "../../../_lib/review-http";
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    const { actorId, canPost } = await reviewAccess(req, "post");
    return res.json({
      ...(await addOpeningEvidence(
        actorId,
        reviewKey(req),
        bankBody(openingEvidenceSchema, req.body)
      )),
      can_post: canPost,
    });
  } catch (error) {
    return bankFailure(res, error);
  }
}
