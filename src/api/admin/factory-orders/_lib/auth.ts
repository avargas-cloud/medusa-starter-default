import type { AuthenticatedMedusaRequest } from "@medusajs/framework/http";

export class UnauthenticatedError extends Error {
  status = 401;
  code = "unauthenticated";
  constructor(message = "Authentication required.") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

export function getActorUserId(req: AuthenticatedMedusaRequest): string {
  const actorId =
    (req.auth_context as { actor_id?: string } | undefined)?.actor_id ?? null;
  if (!actorId) throw new UnauthenticatedError();
  return actorId;
}
