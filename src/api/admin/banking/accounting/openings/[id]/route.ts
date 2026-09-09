import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { readOpening } from "../../../../../../lib/banking/opening-read";
import { reviewAccess } from "../../../../../../lib/banking/review-permissions";
import { bankBody, bankFailure, bankId } from "../../../_lib/http";
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    const { canPost } = await reviewAccess(req);
    return res.json({
      ...(await readOpening(bankBody(bankId, req.params.id))),
      can_post: canPost,
    });
  } catch (error) {
    return bankFailure(res, error);
  }
}
