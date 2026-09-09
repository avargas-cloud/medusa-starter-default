import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { saveAccountingDraft } from "../../../../../../lib/banking/accounting-core";
import { readAccountingTransaction } from "../../../../../../lib/banking/accounting-read";
import { accountingDraftSchema } from "../../../../../../lib/banking/accounting-types";
import { reviewAccess } from "../../../../../../lib/banking/review-permissions";
import { bankBody, bankFailure, bankId } from "../../../_lib/http";
import { reviewCommandRequest } from "../../../_lib/review-http";
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try {
    const { canPost } = await reviewAccess(req);
    return res.json({ ...await readAccountingTransaction(bankBody(bankId, req.params.id)), can_post: canPost });
  } catch (error) { return bankFailure(res, error); }
}
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try {
    const { id, actorId, key, canPost } = await reviewCommandRequest(req, "post");
    return res.json({ ...await saveAccountingDraft(id, actorId, key, bankBody(accountingDraftSchema, req.body)), can_post: canPost });
  } catch (error) { return bankFailure(res, error); }
}

