import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { bankAccess } from "../../../../../../lib/banking/auth";
import { requireBankingSandbox } from "../../../../../../lib/banking/security";
import { refreshBank } from "../../../../../../lib/banking/actions";
import { bankBody, bankFailure, bankId } from "../../../_lib/http";

export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try {
    await bankAccess(req, true);
    requireBankingSandbox();
    return res.status(202).json(await refreshBank(bankBody(bankId, req.params.id)));
  } catch (error) { return bankFailure(res, error); }
}
