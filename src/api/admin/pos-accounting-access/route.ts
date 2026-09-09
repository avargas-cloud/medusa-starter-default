/**
 * src/api/admin/pos-accounting-access/route.ts
 *
 * GET  — lista de usuarios de Medusa con su nivel efectivo (SOLO owner).
 * POST — otorga o revoca Accounting (SOLO owner). Idempotente en ambos sentidos.
 *
 * No hay Idempotency-Key: la auditoría ES la tabla (`pos_accounting_grant`
 * nunca borra, revoca) y el índice único parcial hace que otorgar dos veces
 * sea un no-op. El owner sale de `POS_OWNER_EMAILS`; si la env falta, NADIE es
 * owner y esta ruta contesta 403 a todos — falla cerrado a propósito.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { getDbPool } from "../../utils/db-pool";
import {
  accessFailure,
  assertOwner,
  deriveAccess,
  isOwnerEmail,
  PosAccessError,
} from "../../../lib/pos/access-level";

type AccessRow = {
  user_id: string;
  email: string;
  in_pos_user: boolean;
  pos_is_admin: boolean;
  granted_at: string | null;
  granted_by: string | null;
};

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  try {
    await assertOwner(req);
  } catch (error) {
    return accessFailure(res, error);
  }

  const result = await getDbPool().query<AccessRow>(
    `SELECT u.id AS user_id, lower(u.email) AS email,
            (p.id IS NOT NULL) AS in_pos_user,
            COALESCE(p.is_admin, false) AS pos_is_admin,
            g.granted_at, g.granted_by
       FROM "user" u
       LEFT JOIN pos_accounting_grant g
              ON g.user_id = u.id AND g.revoked_at IS NULL
       LEFT JOIN pos_user p
              ON lower(p.email) = lower(u.email) AND p.deleted_at IS NULL
      WHERE u.deleted_at IS NULL
      ORDER BY lower(u.email), u.id`
  );

  const users = result.rows.map((row) => {
    const derived = deriveAccess({
      isOwner: isOwnerEmail(row.email),
      inPosUser: row.in_pos_user === true,
      posIsAdmin: row.pos_is_admin === true,
      hasActiveGrant: row.granted_at !== null,
    });
    return {
      user_id: row.user_id,
      email: row.email,
      level: derived.level,
      can_admin: derived.canAdmin,
      can_accounting: derived.canAccounting,
      granted_at: row.granted_at,
      granted_by: row.granted_by,
    };
  });

  res.json({ users, count: users.length });
}

const bodySchema = z.object({
  user_id: z.string().min(1).max(128),
  granted: z.boolean(),
  reason: z.string().max(500).optional(),
});

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  let actorId: string;
  try {
    actorId = (await assertOwner(req)).userId;
  } catch (error) {
    return accessFailure(res, error);
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return accessFailure(
      res,
      new PosAccessError("POS_ACCESS_INVALID_REQUEST", 400)
    );
  }
  const { user_id: userId, granted, reason } = parsed.data;
  const pool = getDbPool();

  const target = await pool.query<{ email: string }>(
    `SELECT lower(email) AS email FROM "user" WHERE id=$1 AND deleted_at IS NULL`,
    [userId]
  );
  if (!target.rows[0]) {
    return accessFailure(res, new PosAccessError("POS_USER_NOT_FOUND", 404));
  }

  if (granted) {
    // ON CONFLICT DO NOTHING sobre el índice parcial: si ya hay grant vivo, no-op.
    await pool.query(
      `INSERT INTO pos_accounting_grant (id, user_id, email, granted_by)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [`pag_${randomUUID().replace(/-/g, "")}`, userId, target.rows[0].email, actorId]
    );
  } else {
    await pool.query(
      `UPDATE pos_accounting_grant
          SET revoked_by=$2, revoked_at=NOW(), revoke_reason=$3, updated_at=NOW()
        WHERE user_id=$1 AND revoked_at IS NULL`,
      [userId, actorId, reason ?? null]
    );
  }

  const active = await pool.query<{ granted_at: string; granted_by: string }>(
    `SELECT granted_at, granted_by FROM pos_accounting_grant
      WHERE user_id=$1 AND revoked_at IS NULL`,
    [userId]
  );
  res.json({
    user_id: userId,
    email: target.rows[0].email,
    can_accounting: active.rows.length > 0 || isOwnerEmail(target.rows[0].email),
    granted_at: active.rows[0]?.granted_at ?? null,
    granted_by: active.rows[0]?.granted_by ?? null,
  });
}
