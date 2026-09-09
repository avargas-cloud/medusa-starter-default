import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { previewReceiptAccounting } from "../../../../../../../lib/banking/receipts-core";
import { receiptPreviewSchema } from "../../../../../../../lib/banking/receipts-types";
import { reviewAccess } from "../../../../../../../lib/banking/review-permissions";
import { bankBody, bankFailure, bankId } from "../../../../_lib/http";
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try { const { canPost } = await reviewAccess(req, "post");
    return res.json({ ...await previewReceiptAccounting("deposit", bankBody(bankId, req.params.id), 
      bankBody(receiptPreviewSchema, req.body)), can_post: canPost });
  } catch (error) { return bankFailure(res, error); }
}
