import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { readBankDeposit } from "../../../../../lib/banking/deposit-read";
import { reviewAccess } from "../../../../../lib/banking/review-permissions";
import { bankBody, bankFailure, bankId } from "../../_lib/http";
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    await reviewAccess(req);
    return res.json(await readBankDeposit(bankBody(bankId, req.params.id)));
  } catch (error) {
    return bankFailure(res, error);
  }
}
