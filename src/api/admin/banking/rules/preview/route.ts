import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { reviewAccess } from "../../../../../lib/banking/review-permissions";
import {
  previewReviewRule,
  ruleSchema,
} from "../../../../../lib/banking/review-rules";
import { bankBody, bankFailure } from "../../_lib/http";

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    const { actorId } = await reviewAccess(req, "review");
    return res.json(
      await previewReviewRule(actorId, bankBody(ruleSchema, req.body))
    );
  } catch (error) {
    return bankFailure(res, error);
  }
}
