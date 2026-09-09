import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { matchSuggestions, matchSuggestionsQuery } from "../../../../lib/banking/review-match-suggestions";
import { reviewAccess } from "../../../../lib/banking/review-permissions";
import { bankBody, bankFailure } from "../_lib/http";

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try {
    await reviewAccess(req);
    return res.json(await matchSuggestions(bankBody(matchSuggestionsQuery, req.query)));
  } catch (error) { return bankFailure(res, error); }
}
