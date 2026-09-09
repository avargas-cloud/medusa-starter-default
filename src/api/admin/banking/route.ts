import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { reviewAccess } from "../../../lib/banking/review-permissions";
import { bankingOverview } from "../../../lib/banking/views";

import { bankFailure } from "./_lib/http";

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    const { canManage, canReview, canClose } = await reviewAccess(req);
    return res.json(await bankingOverview(canManage, canReview, canClose));
  } catch (error) {
    return bankFailure(res, error);
  }
}
