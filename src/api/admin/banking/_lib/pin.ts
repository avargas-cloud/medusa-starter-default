import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { getDbPool } from "../../../utils/db-pool";
import {
  extractSupervisorPin,
  resolveActorId,
  pinGuardResponse,
  type PinGuardResult,
} from "../../../../lib/pos/supervisor-pin-guard";
import { pgAsPinConn } from "../../../../lib/pos/verify-supervisor-pin";

/**
 * Cableado del guard de PIN para las rutas de "Manage connections".
 *
 * Deliberadamente NO envuelve a `guardSupervisorPin`: la llamada tiene que
 * quedar escrita en la RUTA, porque así la afirma `verify-pin-enforcement.ts`
 * (§4b, por nombre de archivo y por LLAMADA, no por import). Un wrapper que se
 * llamara distinto dejaría a las seis rutas fuera de ese barrido en silencio.
 * Lo único que se comparte acá es la plomería: de dónde sale la conexión, de
 * dónde el PIN y de dónde el actor.
 */
export function pinGuardInput(req: MedusaRequest): {
  scope: { resolve: (k: string) => unknown };
  db: ReturnType<typeof pgAsPinConn>;
  pin: unknown;
  actorId: string;
} {
  return {
    scope: req.scope as unknown as { resolve: (k: string) => unknown },
    db: pgAsPinConn(getDbPool()),
    pin: extractSupervisorPin(req),
    actorId: resolveActorId(req),
  };
}

/**
 * Escribe la respuesta de rechazo del guard. El mensaje sale del contrato
 * compartido (`pinGuardResponse`): nunca dice qué se esperaba ni cuántos
 * dígitos tiene el PIN.
 */
export function pinGuardFailure(
  res: MedusaResponse,
  guard: Exclude<PinGuardResult, { ok: true }>
) {
  const { status, body } = pinGuardResponse(guard);
  return res.status(status).json(body);
}
