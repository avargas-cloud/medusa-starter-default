import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { postAccountingExpense } from "../../../../../../../lib/banking/accounting-core";
import { accountingPostSchema } from "../../../../../../../lib/banking/accounting-types";
import { bankBody, bankFailure } from "../../../../_lib/http";
import { reviewCommandRequest } from "../../../../_lib/review-http";
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
      ...(await postAccountingExpense(
        id,
        actorId,
        key,
        bankBody(accountingPostSchema, req.body)
      )),
      can_post: canPost,
    });
  } catch (error) {
    return bankFailure(res, error);
  }
}
