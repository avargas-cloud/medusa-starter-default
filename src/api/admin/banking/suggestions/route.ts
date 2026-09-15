import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";

import { reviewAccess } from "../../../../lib/banking/review-permissions";
import { matchSuggestionsQuery } from "../../../../lib/banking/review-match-suggestions";
import { readFeedSuggestions } from "../../../../lib/banking/suggestion-store";
import { bankBody, bankFailure } from "../_lib/http";

/**
 * GET /admin/banking/suggestions?ids=a,b | ?date=YYYY-MM-DD
 * Lo que el casador PROPONE para cada línea del feed que vive en un extracto en BORRADOR:
 * asiento(s) del libro con su hash (kind 'match'), alternativas si es ambigua, o nada; más la
 * categoría sugerida por una regla del producto. Lectura pura; el contador confirma aparte.
 */
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<MedusaResponse> {
  try {
    await reviewAccess(req);
    const q = bankBody(matchSuggestionsQuery, req.query) as z.infer<typeof matchSuggestionsQuery>;
    return res.json(await readFeedSuggestions(q));
  } catch (error) {
    return bankFailure(res, error);
  }
}
