import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { lookupAccounts } from "../../../../../lib/banking/review-lookups";
import { reviewAccess } from "../../../../../lib/banking/review-permissions";
import { bankBody, bankFailure } from "../../_lib/http";
import { lookupQuery } from "../../_lib/review-http";
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    await reviewAccess(req);
    return res.json(await lookupAccounts(bankBody(lookupQuery, req.query).q));
  } catch (error) {
    return bankFailure(res, error);
  }
}
