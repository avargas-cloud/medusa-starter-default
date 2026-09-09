/**
 * src/api/admin/pos-access/me/route.ts
 *
 * GET /admin/pos-access/me — qué puede hacer el usuario autenticado.
 * Devuelve FLAGS, no un rol: la pantalla dibuja con esto, pero cada ruta
 * vuelve a preguntar (`assertAccounting` / `assertAdmin` / `assertOwner`).
 * Un modal nunca autoriza (secrets.md, 4ª extensión).
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import {
  accessFailure,
  resolveAccessLevel,
} from "../../../../lib/pos/access-level";

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  try {
    const identity = await resolveAccessLevel(req);
    res.json({
      level: identity.level,
      is_owner: identity.isOwner,
      can_admin: identity.canAdmin,
      can_accounting: identity.canAccounting,
      in_pos_user: identity.inPosUser,
    });
  } catch (error) {
    return accessFailure(res, error);
  }
}
