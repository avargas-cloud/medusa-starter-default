/**
 * src/api/admin/trip-objectives/_lib/guard.ts
 *
 * Backend authorization for the trip-objectives routes (y, por re-export, para
 * commissions y outsourced-services). El gate del frontend es UX; acá se
 * enforcea de verdad.
 *
 * Regla (2026-09-10): delega en `lib/pos/access-level.ts`. Ya NO existe el
 * "ausente de `pos_user` ⇒ admin ⇒ allow": Accounting es owner o grant vivo en
 * `pos_accounting_grant`. Los nombres exportados se conservan para no tocar
 * los 17 route files que los usan.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import {
  assertAccounting as assertAccessAccounting,
  resolveAccessLevel,
} from "../../../../lib/pos/access-level";

export function getActorUserId(
  req: AuthenticatedMedusaRequest
): string | undefined {
  return req.auth_context?.actor_id;
}

export async function canViewAccounting(
  req: AuthenticatedMedusaRequest
): Promise<boolean> {
  try {
    return (await resolveAccessLevel(req)).canAccounting;
  } catch {
    return false;
  }
}

/**
 * Guard helper for route handlers. Returns true when allowed; otherwise writes
 * a 403 and returns false (the handler should `return` immediately).
 */
export async function assertAccounting(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<boolean> {
  try {
    await assertAccessAccounting(req);
    return true;
  } catch {
    res
      .status(403)
      .json({ error: "Forbidden: accounting access required." });
    return false;
  }
}
