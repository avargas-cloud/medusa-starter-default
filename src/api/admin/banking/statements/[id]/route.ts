import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { reviewAccess } from "../../../../../lib/banking/review-permissions";
import { readStatement } from "../../../../../lib/banking/statement-read";
import { bankBody, bankId, bankFailure } from "../../_lib/http";
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    const access = await reviewAccess(req);
    return res.json({
      ...(await readStatement(bankBody(bankId, req.params.id))),
      can_review: access.canReview,
      can_close: access.canClose,
    });
  } catch (error) {
    return bankFailure(res, error);
  }
}
