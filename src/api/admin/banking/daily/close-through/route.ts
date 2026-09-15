import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { closeDaysThrough, closeThroughSchema, firstOpenDay, yesterday } from "../../../../../lib/banking/review-daily-close-through";
import { reviewAccess } from "../../../../../lib/banking/review-permissions";
import { bankBody, bankFailure } from "../../_lib/http";
import { reviewKey } from "../../_lib/review-http";

/**
 * GET  /admin/banking/daily/close-through            → { from, yesterday }  (qué cerraría)
 * POST /admin/banking/daily/close-through { through } → cierra en orden hasta `through` (< hoy) y
 *      frena en el primer día bloqueado con sus motivos. Capacidad `close`. Idempotency-Key obligatorio.
 */
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<MedusaResponse> {
  try {
    await reviewAccess(req);
    return res.json({ from: await firstOpenDay(), yesterday: yesterday() });
  } catch (error) {
    return bankFailure(res, error);
  }
}

export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<MedusaResponse> {
  try {
    const { actorId } = await reviewAccess(req, "close");
    const key = reviewKey(req);
    return res.json(await closeDaysThrough(actorId, key, bankBody(closeThroughSchema, req.body)));
  } catch (error) {
    return bankFailure(res, error);
  }
}
