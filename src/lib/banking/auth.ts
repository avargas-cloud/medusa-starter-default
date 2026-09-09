import type { AuthenticatedMedusaRequest } from "@medusajs/framework/http";
import { POS_USER_MODULE } from "../../modules/pos-user";
import { BankingError } from "./security";

/** Every cashier is a Medusa user; user authentication alone is insufficient. */
export async function bankIdentity(req: AuthenticatedMedusaRequest) {
  const actorId = req.auth_context?.actor_id;
  if (!actorId) throw new BankingError("BANKING_AUTH_REQUIRED", 401);
  const users = req.scope.resolve("user") as {
    retrieveUser(id: string): Promise<{ email?: string | null }>;
  };
  const user = await users.retrieveUser(actorId);
  if (!user.email) throw new BankingError("BANKING_ACCESS_DENIED", 403);
  const staff = req.scope.resolve(POS_USER_MODULE) as {
    listPosUsers(filters: { email: string }, options: { take: number }):
      Promise<Array<{ can_view_accounting: boolean }>>;
  };
  const rows = await staff.listPosUsers({ email: user.email.toLowerCase() }, { take: 1 });
  const canManage = rows.length === 0;
  return { actorId, canManage, canReadAccounting: canManage || Boolean(rows[0]?.can_view_accounting) };
}

export async function bankAccess(req: AuthenticatedMedusaRequest, manage = false) {
  const { actorId, canManage, canReadAccounting } = await bankIdentity(req);
  if (!canReadAccounting || (manage && !canManage)) {
    throw new BankingError("BANKING_ACCESS_DENIED", 403);
  }
  return { actorId, canManage };
}
