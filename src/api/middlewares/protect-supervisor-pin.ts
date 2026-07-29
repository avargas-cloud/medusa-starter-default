import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

/**
 * Impide que el PIN de supervisor se escriba por la ruta NATIVA de Medusa.
 *
 * ── Por qué existe ────────────────────────────────────────────────────────────
 * El PIN vive en `store.metadata.pos_supervisor_pin`, y la pantalla de Settings
 * lo cambiaba con un `POST /admin/stores/:id` — la ruta que trae el framework,
 * que acepta cualquier metadata y no sabe nada de PINes.
 *
 * En este sistema TODO cajero del POS es un usuario admin de Medusa (así está
 * diseñada la autenticación), así que cualquiera con acceso al POS podía
 * reemplazar el PIN de supervisor por uno propio SIN conocer el anterior,
 * autorizar lo que quisiera, y volver a dejar el viejo. La verificación del PIN
 * anterior existía sólo en el navegador, o sea que no existía.
 *
 * Ése era el habilitador de todo lo demás: con poder cambiar el PIN, los gates
 * que SÍ verifican del lado del servidor se pasan igual.
 *
 * ── Qué hace ──────────────────────────────────────────────────────────────────
 * Rechaza con 409 cualquier intento de escribir (o borrar) esa clave por la ruta
 * nativa, y apunta al único camino legítimo: `POST /admin/pos/supervisor-pin`,
 * que exige el PIN anterior y lo verifica en el servidor.
 *
 * Deja pasar el resto de la metadata sin tocarla — Settings escribe otras cosas
 * por esa misma ruta y tienen que seguir funcionando.
 *
 * NUNCA incluye el valor del PIN en la respuesta ni en un log.
 */
const PIN_KEY = "pos_supervisor_pin";

export function protectSupervisorPin(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const metadata = body.metadata;

  // Sólo interesa el caso en que el caller manda metadata con ESA clave.
  // `in` y no un truthy-check: mandar la clave en null/"" es un intento de
  // BORRAR el PIN, que deja la tienda sin autorización y es igual de grave.
  if (
    metadata &&
    typeof metadata === "object" &&
    PIN_KEY in (metadata as Record<string, unknown>)
  ) {
    return res.status(409).json({
      error:
        "El PIN de supervisor no se puede cambiar por esta ruta. " +
        "Usá POST /admin/pos/supervisor-pin, que exige el PIN anterior.",
      code: "SUPERVISOR_PIN_PROTECTED",
    });
  }

  return next();
}
