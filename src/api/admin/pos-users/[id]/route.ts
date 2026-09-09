/**
 * src/api/admin/pos-users/[id]/route.ts
 * PATCH /admin/pos-users/:id — Update name / is_admin of a POS user record
 * DELETE /admin/pos-users/:id — Permanently removes a POS user record.
 *
 * Administrar el staff del POS es una pantalla de Admin Tools, y Admin Tools es
 * OWNER-ONLY (decisión del operador, 2026-09-10): `assertOwner`, no `assertAdmin`
 * — `canAdmin` sólo habilita confirmar operaciones con PIN escribiendo `confirm`.
 *
 * `can_view_accounting` YA NO se escribe por acá. Hasta 2026-09-10 esta ruta lo
 * escribía SIN ninguna autorización: cualquier token de cajero (todos son
 * usuarios admin de Medusa) se regalaba contabilidad con un PATCH. Ahora
 * Accounting se otorga sólo por `POST /admin/pos-accounting-access` (owner) y
 * queda auditado en `pos_accounting_grant`; mandar la clave vieja es 400.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { POS_USER_MODULE } from "../../../../modules/pos-user";
import { getDbPool } from "../../../utils/db-pool";
import {
  accessFailure,
  assertOwner,
  PosAccessError,
} from "../../../../lib/pos/access-level";

type PosUserModuleLike = {
  updatePosUsers: (
    input: Array<{ id: string; first_name?: string; last_name?: string }>
  ) => Promise<Array<Record<string, unknown>>>;
  deletePosUsers: (ids: string[]) => Promise<unknown>;
};

/** PATCH /admin/pos-users/:id — update first_name / last_name / is_admin */
export async function PATCH(
  req: AuthenticatedMedusaRequest<{
    first_name?: string;
    last_name?: string;
    is_admin?: boolean;
    can_view_accounting?: boolean;
  }>,
  res: MedusaResponse
): Promise<void> {
  try {
    await assertOwner(req);
  } catch (error) {
    return accessFailure(res, error);
  }

  const id = String(req.params.id ?? "");
  const { first_name, last_name, is_admin, can_view_accounting } = req.body;

  if (can_view_accounting !== undefined) {
    return accessFailure(
      res,
      new PosAccessError("ACCOUNTING_GRANT_VIA_OWNER_ONLY", 400)
    );
  }

  const posUserService = req.scope.resolve(
    POS_USER_MODULE
  ) as unknown as PosUserModuleLike;

  let updated: Record<string, unknown> | undefined;
  if (first_name !== undefined || last_name !== undefined) {
    [updated] = await posUserService.updatePosUsers([
      {
        id,
        ...(first_name !== undefined && { first_name }),
        ...(last_name !== undefined && { last_name }),
      },
    ]);
  }

  // `is_admin` es columna cruda (no vive en el modelo del módulo), así que se
  // escribe por SQL parametrizado — nunca interpolando el booleano.
  if (is_admin !== undefined) {
    const written = await getDbPool().query<Record<string, unknown>>(
      `UPDATE pos_user SET is_admin=$2, updated_at=NOW()
        WHERE id=$1 AND deleted_at IS NULL RETURNING *`,
      [id, is_admin]
    );
    if (!written.rows[0]) {
      return accessFailure(res, new PosAccessError("POS_USER_NOT_FOUND", 404));
    }
    updated = written.rows[0];
  }

  if (!updated) {
    const current = await getDbPool().query<Record<string, unknown>>(
      `SELECT * FROM pos_user WHERE id=$1 AND deleted_at IS NULL`,
      [id]
    );
    if (!current.rows[0]) {
      return accessFailure(res, new PosAccessError("POS_USER_NOT_FOUND", 404));
    }
    updated = current.rows[0];
  }

  res.status(200).json({ pos_user: updated });
}

/** DELETE /admin/pos-users/:id */
export async function DELETE(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  try {
    await assertOwner(req);
  } catch (error) {
    return accessFailure(res, error);
  }

  const id = String(req.params.id ?? "");
  const posUserService = req.scope.resolve(
    POS_USER_MODULE
  ) as unknown as PosUserModuleLike;

  await posUserService.deletePosUsers([id]);

  res.status(200).json({ id, deleted: true });
}
