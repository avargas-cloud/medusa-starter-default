import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { voidBankDeposit } from "../../../../../../lib/banking/deposit-core";
import { depositVoidSchema } from "../../../../../../lib/banking/deposit-types";
import { bankBody, bankFailure } from "../../../_lib/http";
import { reviewCommandRequest } from "../../../_lib/review-http";
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    // `review` alcanza para anular un draft/ready; si el depósito está posteado,
    // el void reversa el asiento y voidBankDeposit exige además `canPost`.
    const { id, actorId, key, canPost } = await reviewCommandRequest(req);
    return res.json(
      await voidBankDeposit(
        id,
        actorId,
        key,
        bankBody(depositVoidSchema, req.body),
        canPost
      )
    );
  } catch (error) {
    return bankFailure(res, error);
  }
}
