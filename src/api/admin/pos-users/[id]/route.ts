/**
 * src/api/admin/pos-users/[id]/route.ts
 * PATCH /admin/pos-users/:id — Update name of a POS user record
 * DELETE /admin/pos-users/:id — Permanently removes a POS user record.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { POS_USER_MODULE } from "../../../../modules/pos-user";

/** PATCH /admin/pos-users/:id — update first_name / last_name / can_view_accounting */
export async function PATCH(
  req: AuthenticatedMedusaRequest<{
    first_name?: string;
    last_name?: string;
    can_view_accounting?: boolean;
  }>,
  res: MedusaResponse
) {
  const { id } = req.params;
  const { first_name, last_name, can_view_accounting } = req.body;

  const posUserService = req.scope.resolve(POS_USER_MODULE) as any;

  const [updated] = await posUserService.updatePosUsers([
    {
      id,
      ...(first_name !== undefined && { first_name }),
      ...(last_name !== undefined && { last_name }),
      ...(can_view_accounting !== undefined && { can_view_accounting }),
    },
  ]);

  res.status(200).json({ pos_user: updated });
}

/** DELETE /admin/pos-users/:id */
export async function DELETE(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id } = req.params;
  const posUserService = req.scope.resolve(POS_USER_MODULE) as any;

  await posUserService.deletePosUsers([id]);

  res.status(200).json({ id, deleted: true });
}
