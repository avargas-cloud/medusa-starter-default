import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { previewOpening } from "../../../../../../../lib/banking/opening-core";
import { openingPreviewSchema } from "../../../../../../../lib/banking/opening-types";
import { reviewAccess } from "../../../../../../../lib/banking/review-permissions";
import { bankBody, bankFailure, bankId } from "../../../../_lib/http";
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try { const { canPost } = await reviewAccess(req, "post");
    return res.json({ ...await previewOpening(bankBody(bankId, req.params.id), bankBody(openingPreviewSchema, req.body)), can_post: canPost });
  } catch (error) { return bankFailure(res, error); }
}
