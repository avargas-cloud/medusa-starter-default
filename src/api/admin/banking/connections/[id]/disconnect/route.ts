import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { bankAccess } from "../../../../../../lib/banking/auth";
import { requireBankingEnabled } from "../../../../../../lib/banking/security";
import { disconnectBank } from "../../../../../../lib/banking/actions";
import { bankBody, bankFailure, bankId } from "../../../_lib/http";

export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try {
    await bankAccess(req, true);
    requireBankingEnabled();
    return res.json(await disconnectBank(bankBody(bankId, req.params.id)));
  } catch (error) { return bankFailure(res, error); }
}
