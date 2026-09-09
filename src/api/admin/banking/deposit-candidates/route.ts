import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

import { depositCandidates } from "../../../../lib/banking/deposit-read";
import { reviewAccess } from "../../../../lib/banking/review-permissions";
import { bankBody, bankFailure, bankId } from "../_lib/http";
const query = z.object({
  account_id: bankId,
  q: z.string().max(200).optional(),
  deposit_id: bankId.optional(),
});
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    await reviewAccess(req);
    return res.json(await depositCandidates(bankBody(query, req.query)));
  } catch (error) {
    return bankFailure(res, error);
  }
}
