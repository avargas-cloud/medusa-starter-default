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
    const { id, actorId, key } = await reviewCommandRequest(req);
    return res.json(
      await voidBankDeposit(
        id,
        actorId,
        key,
        bankBody(depositVoidSchema, req.body)
      )
    );
  } catch (error) {
    return bankFailure(res, error);
  }
}
