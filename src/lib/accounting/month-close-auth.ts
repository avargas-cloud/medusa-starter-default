import type { AuthenticatedMedusaRequest } from "@medusajs/framework/http";

import { POS_USER_MODULE } from "../../modules/pos-user";

export class FullAdminRequiredError extends Error {
  status = 403;
  code = "full_admin_required";

  constructor() {
    super("Only a full administrator can close or reopen an accounting month.");
  }
}

export async function requireFullAdmin(
  req: AuthenticatedMedusaRequest
): Promise<string> {
  const actorId = req.auth_context?.actor_id;
  if (!actorId) {
    const error = new FullAdminRequiredError();
    error.status = 401;
    error.code = "unauthenticated";
    throw error;
  }

  const userModule = req.scope.resolve("user") as {
    retrieveUser: (id: string) => Promise<{ email?: string | null }>;
  };
  const user = await userModule.retrieveUser(actorId);
  if (!user.email) throw new FullAdminRequiredError();

  const posUserService = req.scope.resolve(POS_USER_MODULE) as {
    listPosUsers: (
      filters: Record<string, unknown>,
      options?: { take?: number }
    ) => Promise<Array<{ id: string }>>;
  };
  const posUsers = await posUserService.listPosUsers(
    { email: user.email.toLowerCase() },
    { take: 1 }
  );
  if (posUsers.length > 0) throw new FullAdminRequiredError();
  return actorId;
}
