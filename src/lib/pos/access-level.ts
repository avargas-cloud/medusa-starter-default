/**
 * src/lib/pos/access-level.ts
 *
 * ÚNICA fuente de verdad de "qué puede ver este usuario en el POS".
 *
 * La regla vieja —"un usuario de Medusa que NO está en `pos_user` puede TODO"—
 * hacía que cada alta de admin regalara contabilidad. Ahora hay cuatro niveles
 * y dos flags INDEPENDIENTES:
 *
 *   - `canAdmin`      → Owner, o fuera de `pos_user`, o `pos_user.is_admin`.
 *                       NO abre Admin Tools (esas pantallas son owner-only):
 *                       significa que el usuario puede confirmar una operación
 *                       con PIN escribiendo la palabra `confirm` en vez del PIN
 *                       (`lib/pos/supervisor-pin-guard.ts`).
 *   - `canAccounting` → Accounting. Owner, o fila ACTIVA en `pos_accounting_grant`.
 *
 * Contabilidad NO implica Admin ni al revés; `level` es sólo la etiqueta más
 * alta que aplica, nunca la autoridad. Autorizá SIEMPRE por el flag.
 *
 * El owner sale de `POS_OWNER_EMAILS` (env, coma-separada). Ausente o vacía ⇒
 * NADIE es owner: falla CERRADO — nadie puede otorgar Accounting, pero los
 * grants ya otorgados siguen funcionando.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getDbPool } from "../../api/utils/db-pool";

export type AccessLevel = "cashier" | "admin" | "accounting" | "owner";

export type AccessIdentity = {
  userId: string;
  email: string;
  level: AccessLevel;
  isOwner: boolean;
  canAdmin: boolean;
  canAccounting: boolean;
  inPosUser: boolean;
};

export class PosAccessError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.name = "PosAccessError";
    this.code = code;
    this.status = status;
  }
}

/** Emails del owner, siempre lowercase/trim. Vacío ⇒ nadie es owner. */
export function ownerEmails(): string[] {
  return (process.env.POS_OWNER_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

export function isOwnerEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ownerEmails().includes(email.trim().toLowerCase());
}

export type AccessFacts = {
  isOwner: boolean;
  inPosUser: boolean;
  posIsAdmin: boolean;
  hasActiveGrant: boolean;
};

/**
 * Derivación PURA de los flags. Vive acá (y no dentro de la consulta) para que
 * la lista de `/admin/pos-accounting-access` y el guard de cada request usen
 * exactamente la misma tabla de decisión.
 */
export function deriveAccess(facts: AccessFacts): {
  level: AccessLevel;
  canAdmin: boolean;
  canAccounting: boolean;
} {
  const canAccounting = facts.isOwner || facts.hasActiveGrant;
  const canAdmin = facts.isOwner || !facts.inPosUser || facts.posIsAdmin;
  const level: AccessLevel = facts.isOwner
    ? "owner"
    : canAccounting
      ? "accounting"
      : canAdmin
        ? "admin"
        : "cashier";
  return { level, canAdmin, canAccounting };
}

type UserModuleLike = {
  retrieveUser: (id: string) => Promise<{ email?: string | null } | null>;
};

const cache = new WeakMap<object, Promise<AccessIdentity>>();

async function loadAccessLevel(
  req: AuthenticatedMedusaRequest
): Promise<AccessIdentity> {
  const userId = req.auth_context?.actor_id;
  if (!userId) throw new PosAccessError("POS_AUTH_REQUIRED", 401);

  let email: string | null | undefined;
  try {
    const users = req.scope.resolve("user") as unknown as UserModuleLike;
    email = (await users.retrieveUser(userId))?.email;
  } catch {
    throw new PosAccessError("POS_ACCESS_DENIED", 403);
  }
  if (!email) throw new PosAccessError("POS_ACCESS_DENIED", 403);
  const normalized = email.trim().toLowerCase();

  // Una sola ida a la base: presencia en pos_user, su is_admin y el grant vivo.
  const facts = await getDbPool().query<{
    in_pos_user: boolean;
    pos_is_admin: boolean;
    has_grant: boolean;
  }>(
    `SELECT
       EXISTS (SELECT 1 FROM pos_user WHERE lower(email)=$2 AND deleted_at IS NULL) AS in_pos_user,
       COALESCE((SELECT bool_or(is_admin) FROM pos_user WHERE lower(email)=$2 AND deleted_at IS NULL), false) AS pos_is_admin,
       EXISTS (SELECT 1 FROM pos_accounting_grant WHERE user_id=$1 AND revoked_at IS NULL) AS has_grant`,
    [userId, normalized]
  );
  const row = facts.rows[0];
  const isOwner = isOwnerEmail(normalized);
  const derived = deriveAccess({
    isOwner,
    inPosUser: row?.in_pos_user === true,
    posIsAdmin: row?.pos_is_admin === true,
    hasActiveGrant: row?.has_grant === true,
  });

  return {
    userId,
    email: normalized,
    isOwner,
    inPosUser: row?.in_pos_user === true,
    ...derived,
  };
}

/** Resuelve la identidad una sola vez por request (memoizada en el objeto req). */
export function resolveAccessLevel(
  req: AuthenticatedMedusaRequest
): Promise<AccessIdentity> {
  const key = req as unknown as object;
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = loadAccessLevel(req).catch((error: unknown) => {
    // Un fallo transitorio no debe quedar memoizado como veredicto.
    cache.delete(key);
    throw error;
  });
  cache.set(key, pending);
  return pending;
}

/**
 * Misma tabla de decisión, pero partiendo SÓLO del id del usuario: el guard de
 * PIN (`supervisor-pin-guard.ts`) no recibe el request, recibe un `actorId`.
 * Devuelve null si ese id no es un usuario vivo de Medusa.
 */
export async function resolveAccessByUserId(
  userId: string
): Promise<AccessIdentity | null> {
  if (!userId) return null;
  const result = await getDbPool().query<{
    email: string;
    in_pos_user: boolean;
    pos_is_admin: boolean;
    has_grant: boolean;
  }>(
    `SELECT lower(u.email) AS email,
            EXISTS (SELECT 1 FROM pos_user p
                     WHERE lower(p.email)=lower(u.email) AND p.deleted_at IS NULL) AS in_pos_user,
            COALESCE((SELECT bool_or(p.is_admin) FROM pos_user p
                       WHERE lower(p.email)=lower(u.email) AND p.deleted_at IS NULL), false) AS pos_is_admin,
            EXISTS (SELECT 1 FROM pos_accounting_grant g
                     WHERE g.user_id=u.id AND g.revoked_at IS NULL) AS has_grant
       FROM "user" u
      WHERE u.id=$1 AND u.deleted_at IS NULL`,
    [userId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const isOwner = isOwnerEmail(row.email);
  const derived = deriveAccess({
    isOwner,
    inPosUser: row.in_pos_user === true,
    posIsAdmin: row.pos_is_admin === true,
    hasActiveGrant: row.has_grant === true,
  });
  return {
    userId,
    email: row.email,
    isOwner,
    inPosUser: row.in_pos_user === true,
    ...derived,
  };
}

export async function assertAccounting(
  req: AuthenticatedMedusaRequest
): Promise<AccessIdentity> {
  const identity = await resolveAccessLevel(req);
  if (!identity.canAccounting) {
    throw new PosAccessError("ACCOUNTING_ACCESS_REQUIRED", 403);
  }
  return identity;
}

export async function assertOwner(
  req: AuthenticatedMedusaRequest
): Promise<AccessIdentity> {
  const identity = await resolveAccessLevel(req);
  if (!identity.isOwner) throw new PosAccessError("OWNER_REQUIRED", 403);
  return identity;
}

export async function assertAdmin(
  req: AuthenticatedMedusaRequest
): Promise<AccessIdentity> {
  const identity = await resolveAccessLevel(req);
  if (!identity.canAdmin) throw new PosAccessError("ADMIN_REQUIRED", 403);
  return identity;
}

/**
 * Espejo de `bankFailure`: traduce PosAccessError a `{ error, code }` con su
 * status y RE-LANZA cualquier otra cosa (un fallo de base nunca se disfraza
 * de 403 — eso sería fallar abierto en el sentido contrario: silencioso).
 */
export function accessFailure(res: MedusaResponse, error: unknown): void {
  if (error instanceof PosAccessError) {
    res.status(error.status).json({ error: error.code, code: error.code });
    return;
  }
  throw error;
}
