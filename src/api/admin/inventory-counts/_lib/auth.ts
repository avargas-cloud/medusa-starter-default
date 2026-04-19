/**
 * src/api/admin/inventory-counts/_lib/auth.ts
 *
 * Manager-only guard. Approve / reject / preview-approval endpoints call
 * `requireManager(req)` to assert the authenticated admin user is on the
 * POS whitelist with `can_view_accounting=true`.
 *
 * The pos_user table is keyed by email (no user_id FK), so the lookup is:
 *   actor_id → user.email → pos_user (by email) → can_view_accounting
 */

import type { AuthenticatedMedusaRequest } from "@medusajs/framework/http";

import { POS_USER_MODULE } from "../../../../modules/pos-user";

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

interface UserModuleService {
  retrieveUser: (id: string) => Promise<{ email: string }>;
}

interface PosUserModuleService {
  listPosUsers: (
    filters: Record<string, unknown>,
    options?: { take?: number }
  ) => Promise<Array<{ email: string; can_view_accounting: boolean }>>;
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
 * Throws ManagerRoleRequiredError unless the actor is a non-POS admin user
 * (full Medusa admin) OR a pos_user with can_view_accounting=true.
 * Returns the verified user_id on success.
 *
 * Rationale: a Medusa admin user not present in the pos_users whitelist is
 * a "real" backoffice admin (not a cashier) — these always have manager
 * privileges. Cashiers (pos_users) require the explicit accounting flag.
 */
export async function requireManager(
  req: AuthenticatedMedusaRequest
): Promise<string> {
  const userId = getActorUserId(req);

  const userModule = req.scope.resolve("user") as unknown as UserModuleService;
  const user = await userModule.retrieveUser(userId);

  const posUserService = req.scope.resolve(
    POS_USER_MODULE
  ) as unknown as PosUserModuleService;
  const matches = await posUserService.listPosUsers(
    { email: user.email.toLowerCase() },
    { take: 1 }
  );

  const posUser = matches[0];
  // Non-pos admin → full backoffice user, allowed.
  if (!posUser) return userId;
  // Pos cashier → must have explicit accounting flag.
  if (!posUser.can_view_accounting) {
    throw new ManagerRoleRequiredError();
  }

  return userId;
}
