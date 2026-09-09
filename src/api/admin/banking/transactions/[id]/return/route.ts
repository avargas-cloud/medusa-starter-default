import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

import { changeTransactionReviewState } from "../../../../../../lib/banking/review-core";
import { bankBody, bankFailure } from "../../../_lib/http";
import {
  reviewCommandRequest,
  reviewVersions,
} from "../../../_lib/review-http";
const bodySchema = reviewVersions
  .extend({ reason: z.string().trim().min(1).max(1000).optional() })
  .strict();
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    const { id, actorId, key } = await reviewCommandRequest(req);
    return res.json(
      await changeTransactionReviewState(
        id,
        actorId,
        key,
        "return",
        bankBody(bodySchema, req.body)
      )
    );
  } catch (error) {
    return bankFailure(res, error);
  }
}
