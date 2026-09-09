import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { readReceiptSetup, saveReceiptSetup } from "../../../../../lib/banking/receipts-setup";
import { receiptSetupSchema } from "../../../../../lib/banking/receipts-types";
import { reviewAccess } from "../../../../../lib/banking/review-permissions";
import { bankBody, bankFailure } from "../../_lib/http";
import { reviewKey } from "../../_lib/review-http";
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try { const { canPost } = await reviewAccess(req);
    return res.json({ ...await readReceiptSetup(), can_post: canPost });
  } catch (error) { return bankFailure(res, error); }
}
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try { const { actorId, canPost } = await reviewAccess(req, "post");
    return res.json({ ...await saveReceiptSetup(actorId, reviewKey(req), bankBody(receiptSetupSchema, req.body)), can_post: canPost });
  } catch (error) { return bankFailure(res, error); }
}
