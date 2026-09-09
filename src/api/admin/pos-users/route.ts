/**
 * src/api/admin/pos-users/route.ts
 * Admin routes for managing POS-only staff accounts.
 *
 * POST /admin/pos-users — Create a new POS user (uses pre-registered auth identity)
 * GET  /admin/pos-users — List all POS users
 *
 * Ambas exigen `assertOwner`: administrar el staff del POS es una pantalla de
 * Admin Tools, y Admin Tools es owner-only (2026-09-10).
 * `can_view_accounting` sigue en el payload para no romper clientes viejos,
 * pero YA NO sale de la columna: se deriva del grant vivo en
 * `pos_accounting_grant` (la columna quedó como historia, no como autoridad).
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { createPosUserWorkflow } from "../../../workflows/create-pos-user";
import { getDbPool } from "../../utils/db-pool";
import { accessFailure, assertOwner } from "../../../lib/pos/access-level";

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
): Promise<void> {
  try {
    await assertOwner(req);
  } catch (error) {
    return accessFailure(res, error);
  }

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

type PosUserRow = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  is_admin: boolean;
  can_accounting: boolean;
  created_at: Date;
  updated_at: Date;
};

/** GET /admin/pos-users */
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  try {
    await assertOwner(req);
  } catch (error) {
    return accessFailure(res, error);
  }

  try {
    // Una sola consulta: la fila del staff + si tiene grant vivo de Accounting.
    const rows = await getDbPool().query<PosUserRow>(
      `SELECT p.id, p.email, p.first_name, p.last_name,
              COALESCE(p.is_admin, false) AS is_admin,
              EXISTS (
                SELECT 1 FROM pos_accounting_grant g
                 JOIN "user" u ON u.id = g.user_id AND u.deleted_at IS NULL
                WHERE lower(u.email) = lower(p.email) AND g.revoked_at IS NULL
              ) AS can_accounting,
              p.created_at, p.updated_at
         FROM pos_user p
        WHERE p.deleted_at IS NULL
        ORDER BY p.created_at DESC`
    );

    // Activación: existe el usuario de Medusa con ese email.
    let activatedEmails = new Set<string>();
    try {
      const userModule = req.scope.resolve("user") as unknown as {
        listUsers: (f: { email: string[] }) => Promise<Array<{ email: string }>>;
      };
      const posEmails = rows.rows.map((u) => u.email);
      if (posEmails.length > 0) {
        const medusaUsers = await userModule.listUsers({ email: posEmails });
        const userArr = Array.isArray(medusaUsers) ? medusaUsers : [];
        activatedEmails = new Set(userArr.map((u) => u.email));
      }
    } catch {
      /* non-fatal */
    }

    const enriched = rows.rows.map((u) => ({
      ...u,
      activated: activatedEmails.has(u.email),
      // Compatibilidad: los clientes viejos leen esta clave; ahora es el grant.
      can_view_accounting: u.can_accounting,
    }));

    res.json({ pos_users: enriched, count: enriched.length });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
