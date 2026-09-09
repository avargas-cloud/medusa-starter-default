import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { postMerchantReceipt } from "../../../../../lib/banking/merchant-receipts";
import { reviewAccess } from "../../../../../lib/banking/review-permissions";
import { bankFailure } from "../../_lib/http";
import { reviewKey } from "../../_lib/review-http";
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    const access = await reviewAccess(req, "post");
    return res.json({
      ...(await postMerchantReceipt(access.actorId, reviewKey(req), req.body)),
      can_post: access.canPost,
    });
  } catch (error) {
    return bankFailure(res, error);
  }
}
