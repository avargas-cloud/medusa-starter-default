import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";
import { saveBankDeposit } from "../../../../lib/banking/deposit-core";
import { listBankDeposits } from "../../../../lib/banking/deposit-read";
import { depositSaveSchema } from "../../../../lib/banking/deposit-types";
import { reviewAccess } from "../../../../lib/banking/review-permissions";
import { bankBody, bankFailure, bankId } from "../_lib/http";
import { reviewKey } from "../_lib/review-http";
const query = z.object({account_id:bankId.optional(),q:z.string().max(200).optional(),status:z.enum(["draft","ready","void"]).optional()});
export async function GET(req: AuthenticatedMedusaRequest,res: MedusaResponse) {
  try { await reviewAccess(req); return res.json(await listBankDeposits(bankBody(query,req.query))); }
  catch(error) { return bankFailure(res,error); }
}
export async function POST(req: AuthenticatedMedusaRequest,res: MedusaResponse) {
  try { const {actorId}=await reviewAccess(req,"review");
    return res.json(await saveBankDeposit(actorId,reviewKey(req),bankBody(depositSaveSchema,req.body))); }
  catch(error) { return bankFailure(res,error); }
}
