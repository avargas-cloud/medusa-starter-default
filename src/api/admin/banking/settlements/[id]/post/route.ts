import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { postSettlement } from "../../../../../../lib/banking/settlement-core";
import { bankFailure } from "../../../_lib/http";
import { reviewCommandRequest } from "../../../_lib/review-http";
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    const { id, actorId, key, canPost } = await reviewCommandRequest(
      req,
      "post"
    );
    return res.json({
      ...(await postSettlement(id, actorId, key, req.body)),
      can_post: canPost,
    });
  } catch (error) {
    return bankFailure(res, error);
  }
}
