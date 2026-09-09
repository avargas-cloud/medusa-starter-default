import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { reverseReceiptAccounting } from "../../../../../../../lib/banking/receipts-core";
import { receiptReverseSchema } from "../../../../../../../lib/banking/receipts-types";
import { reviewAccess } from "../../../../../../../lib/banking/review-permissions";
import { bankBody, bankFailure, bankId } from "../../../../_lib/http";
import { reviewKey } from "../../../../_lib/review-http";
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    const { canPost, actorId } = await reviewAccess(req, "post");
    return res.json({
      ...(await reverseReceiptAccounting(
        "deposit",
        bankBody(bankId, req.params.id),
        actorId,
        reviewKey(req),
        bankBody(receiptReverseSchema, req.body)
      )),
      can_post: canPost,
    });
  } catch (error) {
    return bankFailure(res, error);
  }
}
