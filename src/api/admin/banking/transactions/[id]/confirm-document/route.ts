import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { confirmFeedDocument, feedDocumentConfirmSchema } from "../../../../../../lib/banking/feed-confirm-document";
import { LedgerError } from "../../../../../../lib/ledger/types";
import { ledgerFailure } from "../../../../../../lib/ledger/documents/manual-http";
import { bankBody, bankFailure } from "../../../_lib/http";
import { reviewCommandRequest } from "../../../_lib/review-http";

/**
 * POST /admin/banking/transactions/:id/confirm-document  { ...preview body, preview_hash }
 * Crea y postea el documento del preview (gl_check o gl_journal_entry), lo encola a QuickBooks y casa
 * la línea. Idempotency-Key obligatorio. Capacidad `post` (escribe en el libro y en QB).
 */
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<MedusaResponse> {
  try {
    const { id, actorId, key } = await reviewCommandRequest(req, "post");
    return res.status(201).json(await confirmFeedDocument(id, actorId, key, bankBody(feedDocumentConfirmSchema, req.body)));
  } catch (error) {
    // Un rechazo del LIBRO (mes cerrado, cuenta inválida) se devuelve con su código, no como fallo genérico de Banking.
    if (error instanceof LedgerError) {
      ledgerFailure(res, error);
      return res;
    }
    return bankFailure(res, error);
  }
}
