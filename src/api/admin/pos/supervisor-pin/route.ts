import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import {
  guardSupervisorPin,
  pinGuardResponse,
  resolveActorId,
} from "../../../../lib/pos/supervisor-pin-guard";
import type { PinConn } from "../../../../lib/pos/verify-supervisor-pin";

/**
 * El ÚNICO camino legítimo para cambiar el PIN de supervisor.
 *
 * GET  /admin/pos/supervisor-pin   → { configured: boolean }   (nunca el valor)
 * POST /admin/pos/supervisor-pin   → { current_pin, new_pin }
 *
 * ── Por qué existe ────────────────────────────────────────────────────────────
 * El cambio se hacía con un `POST /admin/stores/:id` a la ruta nativa de Medusa,
 * que acepta cualquier metadata. Como todo cajero del POS es un usuario admin,
 * cualquiera podía reemplazar el PIN sin conocer el anterior — la verificación
 * del PIN viejo vivía en el navegador. Ese era el agujero que hacía irrelevantes
 * a todos los demás gates: con poder cambiar el PIN, los que sí verifican del
 * lado del servidor se pasan igual.
 *
 * El middleware `protectSupervisorPin` cierra la ruta nativa; esta ruta es el
 * reemplazo, y verifica el PIN anterior EN EL SERVIDOR.
 *
 * ── Reglas ────────────────────────────────────────────────────────────────────
 * - El valor del PIN NUNCA se devuelve, ni se loguea, ni aparece en un error.
 *   El GET contesta si hay uno configurado, no cuál es.
 * - Fail-CLOSED: cualquier problema al leer la tienda deniega, no habilita.
 * - Si NO hay PIN configurado todavía, el primer set no puede pedir el anterior
 *   (no existe) — pero queda auditado como bootstrap, que es un evento distinto
 *   y revisable.
 * - Se audita QUIÉN y CUÁNDO en `store.metadata.pos_supervisor_pin_audit`. Eso
 *   no es secreto: es exactamente lo que hacía falta y no había.
 * - El PIN anterior pasa por `guardSupervisorPin`, no por la comparación
 *   pelada: es lo único que cuenta intentos (adivinar el PIN actual por ACÁ
 *   era la única superficie sin throttle) y lo único que acepta el `confirm`
 *   literal de un admin. Un admin ya autoriza cualquier operación con esa
 *   palabra, así que poder rotar el PIN con ella no le da nada nuevo — pero
 *   la auditoría deja `authorized_via` para que un cambio sin PIN anterior sea
 *   distinguible de uno con él.
 */

/** Mínimo razonable: un PIN de 3 dígitos se adivina a mano. */
const MIN_PIN_LENGTH = 4;

interface StoreRow {
  id: string;
  metadata: Record<string, unknown> | null;
}

async function loadStore(knex: {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
}): Promise<StoreRow | null> {
  const { rows } = await knex.raw(
    `SELECT id, metadata FROM store ORDER BY id LIMIT 1`
  );
  return (rows[0] as StoreRow | undefined) ?? null;
}

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const knex = req.scope.resolve("__pg_connection__") as Parameters<
    typeof loadStore
  >[0];
  try {
    const store = await loadStore(knex);
    const raw = store?.metadata?.pos_supervisor_pin;
    const configured =
      raw !== undefined && raw !== null && String(raw).length > 0;
    const audit = store?.metadata?.pos_supervisor_pin_audit ?? null;
    // `configured` y la auditoría, nunca el valor.
    return res.json({ configured, audit });
  } catch {
    // Fail-closed también acá: decir "no sé" es mejor que decir "no hay".
    return res
      .status(500)
      .json({ error: "No se pudo leer el estado del PIN de supervisor" });
  }
};

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const { current_pin, new_pin } = (req.body ?? {}) as {
    current_pin?: unknown;
    new_pin?: unknown;
  };

  const nextPin = String(new_pin ?? "");
  if (nextPin.length < MIN_PIN_LENGTH) {
    return res.status(400).json({
      error: `El PIN nuevo debe tener al menos ${MIN_PIN_LENGTH} caracteres`,
      code: "PIN_TOO_SHORT",
    });
  }
  if (!/^\d+$/.test(nextPin)) {
    return res.status(400).json({
      error: "El PIN debe ser numérico",
      code: "PIN_NOT_NUMERIC",
    });
  }

  const knex = req.scope.resolve("__pg_connection__") as Parameters<
    typeof loadStore
  >[0];

  let store: StoreRow | null;
  try {
    store = await loadStore(knex);
  } catch {
    return res
      .status(500)
      .json({ error: "No se pudo leer la tienda", code: "STORE_UNREADABLE" });
  }
  if (!store) {
    return res
      .status(500)
      .json({ error: "No hay tienda configurada", code: "NO_STORE" });
  }

  const existing = store.metadata?.pos_supervisor_pin;
  const hasExisting =
    existing !== undefined && existing !== null && String(existing).length > 0;

  // El corazón del arreglo: el PIN anterior se verifica ACÁ, no en el navegador.
  let authorizedVia: "pin" | "admin-confirmation" | "bootstrap" = "bootstrap";
  if (hasExisting) {
    const guard = await guardSupervisorPin({
      scope: req.scope as unknown as { resolve: (k: string) => unknown },
      db: knex as unknown as PinConn,
      pin: current_pin,
      actorId: resolveActorId(req),
    });
    if (!guard.ok) {
      // El mensaje del guard no dice qué se esperaba ni cuántos dígitos tiene.
      const { status, body } = pinGuardResponse(guard);
      return res.status(status).json(body);
    }
    authorizedVia = guard.via;
    if (String(existing) === nextPin) {
      return res.status(400).json({
        error: "El PIN nuevo es igual al actual",
        code: "PIN_UNCHANGED",
      });
    }
  }

  const actor =
    (req as unknown as { auth_context?: { actor_id?: string } }).auth_context
      ?.actor_id ?? "unknown";

  // Auditoría: quién y cuándo. Se conserva el evento anterior para que un
  // cambio no borre el rastro del cambio previo.
  const previousAudit = store.metadata?.pos_supervisor_pin_audit;
  const audit = {
    changed_at: new Date().toISOString(),
    changed_by: actor,
    was_bootstrap: !hasExisting,
    authorized_via: authorizedVia,
    previous: previousAudit ?? null,
  };

  try {
    await knex.raw(
      `UPDATE store
          SET metadata = COALESCE(metadata, '{}'::jsonb) || ?::jsonb,
              updated_at = NOW()
        WHERE id = ?`,
      [
        JSON.stringify({
          pos_supervisor_pin: nextPin,
          pos_supervisor_pin_audit: audit,
        }),
        store.id,
      ]
    );
  } catch {
    return res
      .status(500)
      .json({ error: "No se pudo guardar el PIN", code: "PIN_WRITE_FAILED" });
  }

  // La respuesta confirma el HECHO, nunca el valor.
  return res.json({
    success: true,
    configured: true,
    was_bootstrap: !hasExisting,
    changed_by: actor,
  });
};
