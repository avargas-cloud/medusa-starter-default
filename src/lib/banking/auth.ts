import type { AuthenticatedMedusaRequest } from "@medusajs/framework/http";
import { BankingError } from "./security";
import { assertBankingControl } from "./control";
import { PosAccessError, resolveAccessLevel } from "../pos/access-level";

/**
 * Every cashier is a Medusa user; user authentication alone is insufficient.
 *
 * Desde 2026-09-10 la autoridad es `lib/pos/access-level.ts`: banking exige
 * `canAccounting` (owner o grant vivo). La regla vieja —"ausente de `pos_user`
 * ⇒ puede todo"— convertía cada alta de admin en un permiso de tesorería.
 */
export async function bankIdentity(req: AuthenticatedMedusaRequest) {
  let identity;
  try {
    identity = await resolveAccessLevel(req);
  } catch (error) {
    if (error instanceof PosAccessError) {
      throw new BankingError(
        error.status === 401 ? "BANKING_AUTH_REQUIRED" : "BANKING_ACCESS_DENIED",
        error.status
      );
    }
    throw error;
  }
  return {
    actorId: identity.userId,
    // Manage (connect banks, mapping, setup, permissions, and the shortcut that grants review/close/post)
    // needs Accounting AND Admin (or owner). An Accounting user without Admin keeps only the grains the
    // owner gave in bank_review_permission — otherwise every Accounting grant would silently be full manage.
    canManage: identity.isOwner || (identity.canAccounting && identity.canAdmin),
    canReadAccounting: identity.canAccounting,
  };
}

export async function bankAccess(req: AuthenticatedMedusaRequest, manage = false) {
  const { actorId, canManage, canReadAccounting } = await bankIdentity(req);
  if (!canReadAccounting || (manage && !canManage)) {
    throw new BankingError("BANKING_ACCESS_DENIED", 403);
  }
  // Kill switch: reads keep working so the pause is visible; every mutating request stops here.
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method ?? "")) await assertBankingControl();
  return { actorId, canManage };
}
