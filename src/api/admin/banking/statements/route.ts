import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { listStatements } from "../../../../lib/banking/statement-read";
import { saveStatement } from "../../../../lib/banking/statement-core";
import { reviewAccess } from "../../../../lib/banking/review-permissions";
import { reviewKey } from "../_lib/review-http";
import { bankFailure } from "../_lib/http";
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try { const access = await reviewAccess(req); return res.json({ ...await listStatements(), can_review: access.canReview, can_close: access.canClose }); }
  catch (error) { return bankFailure(res, error); }
}
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try { const access = await reviewAccess(req, "review"); return res.json({ ...await saveStatement(access.actorId, reviewKey(req), req.body),
    can_review: access.canReview, can_close: access.canClose }); } catch (error) { return bankFailure(res, error); }
}
