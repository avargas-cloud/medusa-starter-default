import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { listCompletionEvidence, addCompletionEvidence } from "../../../../lib/banking/completion-evidence";
import { reviewAccess } from "../../../../lib/banking/review-permissions";
import { bankBody, bankFailure } from "../_lib/http";
import { completionEvidenceSchema } from "../../../../lib/banking/movement-types";
import { reviewKey } from "../_lib/review-http";
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try { await reviewAccess(req); return res.json(await listCompletionEvidence()); } catch (error) { return bankFailure(res, error); }
}
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try { const { actorId } = await reviewAccess(req, "review");
    return res.json(await addCompletionEvidence(actorId, reviewKey(req), bankBody(completionEvidenceSchema, req.body))); }
  catch (error) { return bankFailure(res, error); }
}
