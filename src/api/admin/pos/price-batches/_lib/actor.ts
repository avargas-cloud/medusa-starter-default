/**
 * src/api/admin/pos/price-batches/_lib/actor.ts
 *
 * Resolves the authenticated admin user's id + email, for the
 * `created_by_*`/`reviewed_by_*` snapshot columns. Every cashier is a
 * Medusa `user` actor (see `resolveActorId` in supervisor-pin-guard), so this
 * is a plain `user` module lookup — no pos_user role check here (that's
 * `inventory-counts/_lib/auth.ts`'s job for its own manager-only routes).
 */
import type { MedusaRequest } from "@medusajs/framework/http";

import { resolveActorId } from "../../../../../lib/pos/supervisor-pin-guard";

interface UserModuleService {
  retrieveUser: (id: string) => Promise<{ email: string }>;
}

export async function resolveActorIdentity(
  req: MedusaRequest
): Promise<{ userId: string; email: string }> {
  const userId = resolveActorId(req);
  const userModule = req.scope.resolve("user") as unknown as UserModuleService;
  const user = await userModule.retrieveUser(userId);
  return { userId, email: user.email };
}
