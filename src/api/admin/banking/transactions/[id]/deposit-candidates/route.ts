import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { transactionDepositCandidates } from "../../../../../../lib/banking/deposit-matching";
import { reviewAccess } from "../../../../../../lib/banking/review-permissions";
import { bankBody, bankFailure, bankId } from "../../../_lib/http";
export async function GET(req: AuthenticatedMedusaRequest,res: MedusaResponse) {
 try { await reviewAccess(req); return res.json(await transactionDepositCandidates(bankBody(bankId,req.params.id))); }
 catch(error) { return bankFailure(res,error); }
}
