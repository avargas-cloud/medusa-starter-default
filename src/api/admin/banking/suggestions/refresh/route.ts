import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";

import { reviewAccess } from "../../../../../lib/banking/review-permissions";
import { runSuggestions } from "../../../../../lib/banking/suggestion-runner";
import { bankBody, bankFailure, bankId } from "../../_lib/http";

const refreshSchema = z.object({ account_id: bankId.optional() }).strict();

/**
 * POST /admin/banking/suggestions/refresh { account_id? }
 * Corre la misma rutina que el job diario, ahora y para todas las cuentas (o una): extiende los
 * borradores con el feed nuevo y recalcula las sugerencias. Nunca casa ni crea documentos.
 */
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<MedusaResponse> {
  try {
    const { actorId } = await reviewAccess(req, "review");
    const body = bankBody(refreshSchema, req.body ?? {});
    const reports = await runSuggestions({ trigger: "manual", actorId, accountIds: body.account_id ? [body.account_id] : undefined });
    return res.json({ reports });
  } catch (error) {
    return bankFailure(res, error);
  }
}
