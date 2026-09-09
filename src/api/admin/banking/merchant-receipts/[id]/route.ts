import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { readMerchantReceipt } from "../../../../../lib/banking/merchant-receipts";
import { reviewAccess } from "../../../../../lib/banking/review-permissions";
import { bankBody, bankFailure, bankId } from "../../_lib/http";
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    const access = await reviewAccess(req);
    return res.json({
      ...(await readMerchantReceipt(bankBody(bankId, req.params.id))),
      can_post: access.canPost,
      can_review: access.canReview,
    });
  } catch (error) {
    return bankFailure(res, error);
  }
}
