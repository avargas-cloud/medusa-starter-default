import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { confirmFeedMatch, feedConfirmMatchSchema } from "../../../../../../lib/banking/feed-confirm-match";
import { bankBody, bankFailure } from "../../../_lib/http";
import { reviewCommandRequest } from "../../../_lib/review-http";

/**
 * POST /admin/banking/transactions/:id/confirm-match  { allocations: [{ book_id, amount_cents, expected_book_hash }] }
 * El contador confirma la sugerencia (o los candidatos que eligió): crea el/los bank_statement_match
 * contra el borrador del mes. Idempotency-Key obligatorio. Capacidad `review`.
 */
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<MedusaResponse> {
  try {
    const { id, actorId, key } = await reviewCommandRequest(req, "review");
    return res.json(await confirmFeedMatch(id, actorId, key, bankBody(feedConfirmMatchSchema, req.body)));
  } catch (error) {
    return bankFailure(res, error);
  }
}
