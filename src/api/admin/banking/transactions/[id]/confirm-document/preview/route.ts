import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { feedDocumentSchema, previewFeedDocument } from "../../../../../../../lib/banking/feed-confirm-document";
import { reviewAccess } from "../../../../../../../lib/banking/review-permissions";
import { bankBody, bankFailure, bankId } from "../../../../_lib/http";

/**
 * POST /admin/banking/transactions/:id/confirm-document/preview  { category_list_id, payee_type?, payee_id?, payee_name, number?, memo? }
 * Lo que se crearía (documento, kind, asiento Dr/Cr, tipo de request a QuickBooks) y su hash. Lectura pura.
 */
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<MedusaResponse> {
  try {
    await reviewAccess(req, "review");
    const id = bankBody(bankId, req.params.id);
    return res.json({ preview: await previewFeedDocument(id, bankBody(feedDocumentSchema, req.body)) });
  } catch (error) {
    return bankFailure(res, error);
  }
}
