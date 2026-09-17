/**
 * src/lib/calendar/recurring-http.ts
 *
 * Lo que comparten las rutas de /admin/accounting/recurring-expenses: el gate
 * de nivel (`assertAccounting`), el gate de PIN EN LA RUTA para toda escritura
 * de regla (`guardSupervisorPin`, con throttle por usuario — el modal sólo
 * recolecta la credencial y la manda en `x-supervisor-pin`), y el handle pg.
 */
import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

// Path escrito con `lib/pos/access-level` a propósito: `verify-accounting-guard`
// afirma por ese literal que este delegante resuelve contra el access-level real.
import { accessFailure, assertAccounting } from "../../lib/pos/access-level";
import {
  extractSupervisorPin,
  guardSupervisorPin,
  pinGuardResponse,
  resolveActorId,
} from "../pos/supervisor-pin-guard";
import type { PinConn } from "../pos/verify-supervisor-pin";

import type { RawPg } from "./recurring-repo";

export function pgOf(req: MedusaRequest): RawPg {
  return req.scope.resolve("__pg_connection__") as RawPg;
}

/** Nivel accounting o nada. Devuelve false ya habiendo contestado. */
export async function requireAccounting(req: MedusaRequest, res: MedusaResponse): Promise<boolean> {
  try {
    await assertAccounting(req as AuthenticatedMedusaRequest);
    return true;
  } catch (error) {
    accessFailure(res, error);
    return false;
  }
}

/** PIN de supervisor verificado en la ruta. Devuelve false ya habiendo contestado. */
export async function requirePin(req: MedusaRequest, res: MedusaResponse, pg: RawPg): Promise<boolean> {
  const guard = await guardSupervisorPin({
    scope: req.scope as unknown as { resolve: (k: string) => unknown },
    db: pg as unknown as PinConn,
    pin: extractSupervisorPin(req),
    actorId: resolveActorId(req),
  });
  if (guard.ok) return true;
  const { status, body } = pinGuardResponse(guard);
  res.status(status).json(body);
  return false;
}

export { resolveActorId };
