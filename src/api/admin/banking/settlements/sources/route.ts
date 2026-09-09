import { z } from "zod";
import type { AuthenticatedMedusaRequest,MedusaResponse } from "@medusajs/framework/http";
import { listSettlementSources } from "../../../../../lib/banking/settlement-lookups";
import { reviewAccess } from "../../../../../lib/banking/review-permissions";
import { bankBody,bankFailure } from "../../_lib/http";
const querySchema=z.object({kind:z.enum(["card_payment","receipt","refund","reserve_release"]),q:z.string().max(200).default("")});
export async function GET(req:AuthenticatedMedusaRequest,res:MedusaResponse) {
  try {await reviewAccess(req);const query=bankBody(querySchema,req.query);return res.json(await listSettlementSources(query.kind,query.q));}
  catch(error) {return bankFailure(res,error);}
}
