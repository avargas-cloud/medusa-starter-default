import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { confirmTransactionReview } from "../../../../../../lib/banking/review-core";
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
      await confirmTransactionReview(
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
