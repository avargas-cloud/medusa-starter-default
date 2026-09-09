import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { refreshBank } from "../../../../../../lib/banking/actions";
import { bankAccess } from "../../../../../../lib/banking/auth";
import { requireBankingEnabled } from "../../../../../../lib/banking/security";
import { bankBody, bankFailure, bankId } from "../../../_lib/http";

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    await bankAccess(req, true);
    requireBankingEnabled();
    return res
      .status(202)
      .json(await refreshBank(bankBody(bankId, req.params.id)));
  } catch (error) {
    return bankFailure(res, error);
  }
}
