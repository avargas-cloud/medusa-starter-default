/**
 * Guard de PIN de supervisor con límite de intentos.
 *
 * ── Por qué existe ────────────────────────────────────────────────────────────
 * `verifySupervisorPin` contesta sí/no y nada más. Eso alcanzaba mientras el PIN
 * fuera un cartel: para probarlo había que conocer el valor, que además viajaba
 * al navegador.
 *
 * Cuando el PIN pasa a ser la autorización REAL de operaciones de dinero y de
 * stock, aparece el problema aritmético: un PIN de 4 dígitos son 10.000
 * combinaciones, y un script las prueba en segundos. Sin límite de intentos,
 * mover la verificación al servidor cambia "hay que saber el PIN" por "hay que
 * adivinarlo", que no es una mejora.
 *
 * ── Cómo cuenta ───────────────────────────────────────────────────────────────
 * Los intentos fallidos se cuentan POR USUARIO en el cache de Redis, con ventana
 * deslizante. Un acierto limpia el contador. Al llegar al tope se rechaza SIN
 * mirar el PIN — así el bloqueo no se puede sondear midiendo el tiempo de
 * respuesta.
 *
 * Se cuenta por usuario y no por IP a propósito: en el showroom todas las cajas
 * salen por la misma IP, así que un límite por IP castigaría al mostrador entero
 * por un empleado, y no frenaría a un atacante autenticado — que es el modelo de
 * amenaza real acá, porque cada cajero ya tiene un token admin válido.
 *
 * Fail-OPEN sólo ante fallas del CACHE, nunca del PIN: si Redis no responde, el
 * PIN se sigue verificando contra Postgres y lo único que se pierde es el conteo.
 * Un cache caído no puede dejar a la tienda sin poder autorizar nada.
 */
import { Modules } from "@medusajs/utils";

import { verifySupervisorPin, type PinConn } from "./verify-supervisor-pin";

/** Intentos fallidos permitidos antes de bloquear. */
export const MAX_PIN_ATTEMPTS = 8;

/** Cuánto dura el bloqueo (y la ventana de conteo), en segundos. */
export const PIN_LOCKOUT_SECONDS = 15 * 60;

export type PinGuardResult =
  | { ok: true }
  | { ok: false; reason: "invalid"; attemptsLeft: number }
  | { ok: false; reason: "locked"; retryAfterSeconds: number };

interface CacheLike {
  get: <T>(key: string) => Promise<T | null>;
  set: (key: string, data: unknown, ttl?: number) => Promise<void>;
  invalidate: (key: string) => Promise<void>;
}

interface ScopeLike {
  resolve: (key: string) => unknown;
}

function attemptsKey(actorId: string): string {
  return `pos:supervisor-pin:attempts:${actorId}`;
}

/** El id del usuario autenticado, o un cubo compartido si no se puede resolver. */
export function resolveActorId(req: unknown): string {
  const ctx = (req as { auth_context?: { actor_id?: string } })?.auth_context;
  return ctx?.actor_id ?? "unknown-actor";
}

/**
 * Extrae el PIN de un request, mirando el HEADER y el body.
 *
 * El header (`x-supervisor-pin`) es la forma preferida: es una credencial, y
 * ademas sirve donde el body no llega — un DELETE no lo lleva, algunos schemas
 * zod lo filtrarian, y un guardado que pega a ocho rutas necesitaria el campo
 * inyectado en ocho cuerpos distintos.
 *
 * El body sigue aceptado porque varias rutas ya lo mandan asi y no hay motivo
 * para romperlas.
 */
export function extractSupervisorPin(req: unknown): unknown {
  const r = req as {
    headers?: Record<string, unknown>;
    body?: { supervisor_pin?: unknown };
  };
  const header = r?.headers?.["x-supervisor-pin"];
  if (typeof header === "string" && header.length > 0) return header;
  if (Array.isArray(header) && typeof header[0] === "string") return header[0];
  return r?.body?.supervisor_pin;
}

function getCache(scope: ScopeLike): CacheLike | null {
  try {
    return scope.resolve(Modules.CACHE) as CacheLike;
  } catch {
    return null;
  }
}

/**
 * Verifica el PIN contando intentos. Devuelve un resultado tipado en vez de
 * lanzar, para que cada ruta elija su status code y su mensaje.
 *
 * El mensaje que la ruta construya NUNCA debe decir qué se esperaba ni cuántos
 * dígitos tiene el PIN.
 */
export async function guardSupervisorPin(input: {
  scope: ScopeLike;
  db: PinConn;
  pin: unknown;
  actorId: string;
}): Promise<PinGuardResult> {
  const { scope, db, pin, actorId } = input;
  const cache = getCache(scope);
  const key = attemptsKey(actorId);

  let failures = 0;
  if (cache) {
    try {
      failures = Number((await cache.get<number>(key)) ?? 0);
    } catch {
      // Cache ilegible: se sigue sin conteo (ver fail-open del docstring).
      failures = 0;
    }
  }

  // Se rechaza ANTES de mirar el PIN: un bloqueo que primero compara filtra,
  // por tiempo de respuesta, si el valor era correcto.
  if (failures >= MAX_PIN_ATTEMPTS) {
    return {
      ok: false,
      reason: "locked",
      retryAfterSeconds: PIN_LOCKOUT_SECONDS,
    };
  }

  const valid = await verifySupervisorPin(db, pin);

  if (valid) {
    if (cache) {
      // Un acierto limpia el historial: el objetivo es frenar el barrido, no
      // castigar a quien se equivocó una vez y después acertó.
      await cache.invalidate(key).catch(() => {});
    }
    return { ok: true };
  }

  const next = failures + 1;
  if (cache) {
    await cache.set(key, next, PIN_LOCKOUT_SECONDS).catch(() => {});
  }
  return {
    ok: false,
    reason: "invalid",
    attemptsLeft: Math.max(0, MAX_PIN_ATTEMPTS - next),
  };
}

/**
 * Traduce el resultado a una respuesta HTTP uniforme, para que las ~20 rutas que
 * verifican PIN no inventen cada una su propio formato — el frontend mapea UN
 * contrato.
 */
export function pinGuardResponse(result: Exclude<PinGuardResult, { ok: true }>): {
  status: number;
  body: Record<string, unknown>;
} {
  if (result.reason === "locked") {
    return {
      status: 429,
      body: {
        message:
          "Demasiados intentos fallidos de PIN. Esperá unos minutos antes de reintentar.",
        code: "SUPERVISOR_PIN_LOCKED",
        retry_after_seconds: result.retryAfterSeconds,
      },
    };
  }
  return {
    status: 403,
    body: {
      message: "PIN de supervisor inválido",
      code: "INVALID_SUPERVISOR_PIN",
      attempts_left: result.attemptsLeft,
    },
  };
}
