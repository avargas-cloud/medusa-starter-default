/**
 * src/api/admin/inventory-counts/_lib/auth.ts
 *
 * Manager-only guard. Approve / reject / preview-approval endpoints call
 * `requireManager(req)`.
 *
 * Regla (2026-09-10): delega en `lib/pos/access-level.ts`. La regla vieja
 * —"un usuario de Medusa ausente de `pos_user` es un admin de backoffice y por
 * eso siempre es manager"— convertía cada alta en un aprobador de conteos.
 * Ahora manager = acceso a Accounting: owner o grant vivo en
 * `pos_accounting_grant`.
 */

import type { AuthenticatedMedusaRequest } from "@medusajs/framework/http";

import {
  assertAccounting,
  PosAccessError,
} from "../../../../lib/pos/access-level";

export class ManagerRoleRequiredError extends Error {
  status = 403;
  code = "manager_role_required";
  constructor(message = "This action requires a POS accounting manager.") {
    super(message);
    this.name = "ManagerRoleRequiredError";
  }
}

export class UnauthenticatedError extends Error {
  status = 401;
  code = "unauthenticated";
  constructor(message = "Authentication required.") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

/**
 * Resolve the user_id of the authenticated admin. Medusa v2 places this in
 * `req.auth_context.actor_id` (the canonical actor id for `user`-actor JWTs).
 */
export function getActorUserId(req: AuthenticatedMedusaRequest): string {
  const actorId =
    (req.auth_context as { actor_id?: string } | undefined)?.actor_id ?? null;

  if (!actorId) {
    throw new UnauthenticatedError();
  }

  return actorId;
}

/**
 * Throws ManagerRoleRequiredError unless the actor has Accounting access.
 * Returns the verified user_id on success.
 */
export async function requireManager(
  req: AuthenticatedMedusaRequest
): Promise<string> {
  try {
    return (await assertAccounting(req)).userId;
  } catch (error) {
    if (error instanceof PosAccessError && error.status === 401) {
      throw new UnauthenticatedError();
    }
    throw new ManagerRoleRequiredError();
  }
}
