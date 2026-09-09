import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { bankAccess } from "../../../../../../lib/banking/auth";
import { requireBankingSandbox } from "../../../../../../lib/banking/security";
import { reconnectBank } from "../../../../../../lib/banking/actions";
import { bankBody, bankFailure, bankId } from "../../../_lib/http";

export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try {
    await bankAccess(req, true);
    requireBankingSandbox();
    return res.json(await reconnectBank(bankBody(bankId, req.params.id)));
  } catch (error) { return bankFailure(res, error); }
}
