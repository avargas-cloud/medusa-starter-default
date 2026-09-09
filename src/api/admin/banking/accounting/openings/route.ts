import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { saveOpening } from "../../../../../lib/banking/opening-core";
import { listOpenings } from "../../../../../lib/banking/opening-read";
import { openingSaveSchema } from "../../../../../lib/banking/opening-types";
import { reviewAccess } from "../../../../../lib/banking/review-permissions";
import { bankBody, bankFailure } from "../../_lib/http";
import { reviewKey } from "../../_lib/review-http";
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    const { actorId, canPost } = await reviewAccess(req, "post");
    return res.json({
      ...(await saveOpening(
        actorId,
        reviewKey(req),
        bankBody(openingSaveSchema, req.body)
      )),
      can_post: canPost,
    });
  } catch (error) {
    return bankFailure(res, error);
  }
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    const { canPost } = await reviewAccess(req);
    return res.json({ ...(await listOpenings()), can_post: canPost });
  } catch (error) {
    return bankFailure(res, error);
  }
}
