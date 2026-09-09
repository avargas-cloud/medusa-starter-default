import type { AuthenticatedMedusaRequest } from "@medusajs/framework/http";

import {
  assertAccounting,
  PosAccessError,
} from "../pos/access-level";

/**
 * Cerrar o reabrir un mes contable exige acceso a Accounting (owner o grant
 * vivo en `pos_accounting_grant`).
 *
 * El nombre `requireFullAdmin` se conserva por sus cinco callsites, pero la
 * regla que codificaba —"ausente de `pos_user` ⇒ full admin ⇒ puede cerrar el
 * mes"— murió el 2026-09-10: era el permiso más caro del POS regalado con cada
 * alta de usuario de Medusa. La autoridad ahora es `lib/pos/access-level.ts`.
 */
export class FullAdminRequiredError extends Error {
  status = 403;
  code = "full_admin_required";

  constructor() {
    super("Only an accounting user can close or reopen an accounting month.");
  }
}

export async function requireFullAdmin(
  req: AuthenticatedMedusaRequest
): Promise<string> {
  try {
    return (await assertAccounting(req)).userId;
  } catch (error) {
    const denied = new FullAdminRequiredError();
    if (error instanceof PosAccessError && error.status === 401) {
      denied.status = 401;
      denied.code = "unauthenticated";
    }
    throw denied;
  }
}
