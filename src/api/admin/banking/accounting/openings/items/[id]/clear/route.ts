import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { clearOpeningItem } from "../../../../../../../../lib/banking/opening-clear";
import { openingClearSchema } from "../../../../../../../../lib/banking/opening-types";
import { reviewAccess } from "../../../../../../../../lib/banking/review-permissions";
import { bankBody, bankFailure, bankId } from "../../../../../_lib/http";
import { reviewKey } from "../../../../../_lib/review-http";
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try { const { actorId, canPost } = await reviewAccess(req, "post");
    return res.json({ ...await clearOpeningItem(bankBody(bankId, req.params.id), actorId, reviewKey(req), bankBody(openingClearSchema, req.body)), can_post: canPost });
  } catch (error) { return bankFailure(res, error); }
}
