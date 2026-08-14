/**
 * Order Commissions — guards de ruta.
 *
 * Reusa el guard de accounting de trip-objectives (misma regla que el sidebar:
 * admin fuera del whitelist POS → allow; pos_user → can_view_accounting) y el
 * guard de PIN de supervisor con throttle. La RUTA es la autoridad; el modal
 * del POS solo recolecta la credencial (regla de secrets.md, 4ª extensión).
 */

export { assertAccounting, getActorUserId } from "../../trip-objectives/_lib/guard";

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { getDbPool } from "../../../utils/db-pool";
import {
  extractSupervisorPin,
  guardSupervisorPin,
  pinGuardResponse,
  resolveActorId,
} from "../../../../lib/pos/supervisor-pin-guard";
import { pgAsPinConn } from "../../../../lib/pos/verify-supervisor-pin";

/**
 * Verifica el PIN de supervisor del header `x-supervisor-pin`.
 * Devuelve el actorId cuando pasa; escribe la respuesta de error y devuelve
 * null cuando no (el handler debe `return` inmediatamente).
 */
export async function requireSupervisorPin(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<{ actorId: string | null } | null> {
  const guard = await guardSupervisorPin({
    scope: req.scope as unknown as { resolve: (k: string) => unknown },
    db: pgAsPinConn(getDbPool()),
    pin: extractSupervisorPin(req),
    actorId: resolveActorId(req),
  });
  if (!guard.ok) {
    const { status, body } = pinGuardResponse(guard);
    res.status(status).json(body);
    return null;
  }
  return { actorId: resolveActorId(req) ?? null };
}
