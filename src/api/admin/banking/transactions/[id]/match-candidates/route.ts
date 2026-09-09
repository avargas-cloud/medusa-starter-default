import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { matchCandidates } from "../../../../../../lib/banking/review-matching";
import { reviewAccess } from "../../../../../../lib/banking/review-permissions";
import { bankBody, bankFailure, bankId } from "../../../_lib/http";
import { lookupQuery } from "../../../_lib/review-http";
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    await reviewAccess(req);
    return res.json(
      await matchCandidates(
        bankBody(bankId, req.params.id),
        bankBody(lookupQuery, req.query).q
      )
    );
  } catch (error) {
    return bankFailure(res, error);
  }
}
