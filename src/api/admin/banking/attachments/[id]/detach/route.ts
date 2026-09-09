import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { detachReviewAttachment } from "../../../../../../lib/banking/review-attachments";
import { bankBody, bankFailure } from "../../../_lib/http";
import {
  reviewCommandRequest,
  reviewVersions,
} from "../../../_lib/review-http";
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    const { id, actorId, key } = await reviewCommandRequest(req);
    return res.json(
      await detachReviewAttachment(
        id,
        actorId,
        key,
        bankBody(reviewVersions.strict(), req.body)
      )
    );
  } catch (error) {
    return bankFailure(res, error);
  }
}
