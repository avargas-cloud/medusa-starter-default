import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";
import { saveTransactionReview } from "../../../../../../lib/banking/review-core";
import { readTransactionReview } from "../../../../../../lib/banking/review-read";
import { reviewAccess } from "../../../../../../lib/banking/review-permissions";
import { bankBody, bankFailure, bankId } from "../../../_lib/http";
import { reviewCommandRequest, reviewVersions } from "../../../_lib/review-http";

const bodySchema = reviewVersions.extend({
  mode: z.enum(["categorize", "match", "deposit"]),
  category_list_id: bankId.nullable().optional(),
  counterparty_type: z.enum(["vendor", "customer"]).nullable().optional(),
  counterparty_id: bankId.nullable().optional(),
  comment: z.string().max(4000),
  matched_deposit_id: bankId.nullable().optional(),
  expected_deposit_source_hash: z.string().regex(/^[a-f0-9]{32}$/).nullable().optional(),
  matched_payment_id: bankId.nullable().optional(),
  expected_match_source_hash: z.string().regex(/^[a-f0-9]{32}$/).nullable().optional(),
}).strict();
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try {
    await reviewAccess(req);
    return res.json(await readTransactionReview(bankBody(bankId, req.params.id)));
  } catch (error) { return bankFailure(res, error); }
}
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try {
    const { id, actorId, key } = await reviewCommandRequest(req);
    return res.json(await saveTransactionReview(id, actorId, key, bankBody(bodySchema, req.body)));
  } catch (error) { return bankFailure(res, error); }
}
