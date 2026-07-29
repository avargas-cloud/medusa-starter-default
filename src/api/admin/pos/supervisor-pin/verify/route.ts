import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import {
  guardSupervisorPin,
  pinGuardResponse,
  resolveActorId,
} from "../../../../../lib/pos/supervisor-pin-guard";
import type { PinConn } from "../../../../../lib/pos/verify-supervisor-pin";

/**
 * POST /admin/pos/supervisor-pin/verify   → { pin } → 200 { valid: true }
 *
 * Existe para los gates que sólo DESBLOQUEAN el modo edición de una pantalla.
 * Esos no tienen una operación contra la que verificar en el momento: si el PIN
 * se validara recién al guardar, el operador haría todo su trabajo y perdería
 * los cambios al descubrir que el PIN estaba mal.
 *
 * NO reemplaza la verificación de la operación. El modal usa esto para poder
 * dejar de leer el valor del PIN, y después le pasa el PIN al caller, cuya ruta
 * lo vuelve a verificar — es lo que el propio docstring del modal ya pedía:
 * "un chequeo sólo del lado del cliente no es un gate real".
 *
 * Tiene límite de intentos (ver supervisor-pin-guard.ts). Sin eso este endpoint
 * sería un oráculo de fuerza bruta: 10.000 combinaciones para un PIN de 4
 * dígitos se prueban en segundos.
 *
 * Nunca devuelve el PIN ni pistas sobre él.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const { pin } = (req.body ?? {}) as { pin?: unknown };
  const db = req.scope.resolve("__pg_connection__") as PinConn;

  const result = await guardSupervisorPin({
    scope: req.scope as unknown as { resolve: (k: string) => unknown },
    db,
    pin,
    actorId: resolveActorId(req),
  });

  if (!result.ok) {
    const { status, body } = pinGuardResponse(result);
    return res.status(status).json(body);
  }

  return res.json({ valid: true });
};
