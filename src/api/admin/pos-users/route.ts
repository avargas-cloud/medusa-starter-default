/**
 * src/api/admin/pos-users/route.ts
 * Admin routes for managing POS-only staff accounts.
 *
 * POST /admin/pos-users — Create a new POS user (uses pre-registered auth identity)
 * GET  /admin/pos-users — List all POS users
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { POS_USER_MODULE } from "../../../modules/pos-user";
import { createPosUserWorkflow } from "../../../workflows/create-pos-user";

type CreatePosUserBody = {
  email: string;
  first_name?: string;
  last_name?: string;
  /** auth_identity_id from POST /auth/pos_user/emailpass */
  auth_identity_id: string;
};

/** POST /admin/pos-users */
export async function POST(
  req: AuthenticatedMedusaRequest<CreatePosUserBody>,
  res: MedusaResponse
) {
  const { email, first_name, last_name, auth_identity_id } = req.body;

  const { result } = await createPosUserWorkflow(req.scope).run({
    input: {
      email,
      first_name,
      last_name,
      authIdentityId: auth_identity_id,
    },
  });

  res.status(201).json({ pos_user: result });
}

/** GET /admin/pos-users */
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    const posUserService = req.scope.resolve(POS_USER_MODULE) as any;
    const [pos_users] = await posUserService.listAndCountPosUsers(
      {},
      { order: { created_at: "DESC" } }
    );

    // Check which users have activated using the Medusa user module
    let activatedEmails = new Set<string>();
    try {
      const userModule = req.scope.resolve("user") as any;
      const posEmails = pos_users.map((u: any) => u.email);
      if (posEmails.length > 0) {
        const medusaUsers = await userModule.listUsers({ email: posEmails });
        const userArr = Array.isArray(medusaUsers) ? medusaUsers : [];
        activatedEmails = new Set(userArr.map((u: any) => u.email));
      }
    } catch {
      /* non-fatal */
    }

    const enriched = pos_users.map((u: any) => ({
      ...u,
      activated: activatedEmails.has(u.email),
    }));

    res.json({ pos_users: enriched, count: enriched.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
