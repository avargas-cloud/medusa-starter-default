import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { readyBankDeposit } from "../../../../../../lib/banking/deposit-core";
import { depositReadySchema } from "../../../../../../lib/banking/deposit-types";
import { bankBody, bankFailure } from "../../../_lib/http";
import { reviewCommandRequest } from "../../../_lib/review-http";
export async function POST(req: AuthenticatedMedusaRequest,res: MedusaResponse) {
 try { const {id,actorId,key}=await reviewCommandRequest(req);
 return res.json(await readyBankDeposit(id,actorId,key,bankBody(depositReadySchema,req.body))); }
 catch(error) { return bankFailure(res,error); }
}
