/**
 * src/api/admin/trip-objectives/_lib/guard.ts
 *
 * Backend authorization for the trip-objectives routes. The frontend gate is
 * UX only; these helpers enforce the same "accounting" rule server-side so the
 * Decisions data can't be read by hitting the API directly.
 *
 * Rule (matches the POS sidebar convention `isAdmin || canViewAccounting`):
 *   - actor is a Medusa user NOT in the pos_users whitelist  → admin → allow
 *   - actor IS a pos_user                                    → allow iff can_view_accounting
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { POS_USER_MODULE } from "../../../../modules/pos-user";

interface UserModuleLike {
  retrieveUser: (id: string) => Promise<{ email?: string } | null>;
}
interface PosUserModuleLike {
  listPosUsers: (
    f: Record<string, unknown>
  ) => Promise<Array<{ can_view_accounting?: boolean }>>;
}

export function getActorUserId(
  req: AuthenticatedMedusaRequest
): string | undefined {
  return req.auth_context?.actor_id;
}

export async function canViewAccounting(
  req: AuthenticatedMedusaRequest
): Promise<boolean> {
  const actorId = getActorUserId(req);
  if (!actorId) return false;

  let email: string | undefined;
  try {
    const userModule = req.scope.resolve("user") as UserModuleLike;
    const user = await userModule.retrieveUser(actorId);
    email = user?.email;
  } catch {
    return false;
  }
  if (!email) return false;

  const posUserService = req.scope.resolve(
    POS_USER_MODULE
  ) as PosUserModuleLike;
  const posUsers = await posUserService.listPosUsers({ email });

  // Not in the POS whitelist → admin staff → allowed.
  if (posUsers.length === 0) return true;
  return Boolean(posUsers[0]?.can_view_accounting);
}

/**
 * Guard helper for route handlers. Returns true when allowed; otherwise writes
 * a 403 and returns false (the handler should `return` immediately).
 */
export async function assertAccounting(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<boolean> {
  const ok = await canViewAccounting(req);
  if (!ok) {
    res
      .status(403)
      .json({ error: "Forbidden: accounting access required." });
    return false;
  }
  return true;
}
