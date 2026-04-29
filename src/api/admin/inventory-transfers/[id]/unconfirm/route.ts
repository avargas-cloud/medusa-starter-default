/**
 * src/api/admin/inventory-transfers/[id]/unconfirm/route.ts
 *
 * POST /admin/inventory-transfers/:id/unconfirm
 *
 * Transitions: shipped → confirmed
 * Clears shipped_at and shipped_by_user_id.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getActorUserId, UnauthenticatedError } from "../../../purchase-orders/_lib/auth";

type KnexInstance = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

function resolveKnex(req: AuthenticatedMedusaRequest): KnexInstance {
  return (req.scope as unknown as { resolve: (k: string) => unknown }).resolve(
    "__pg_connection__"
  ) as KnexInstance;
}

interface TransferRow {
  id: string;
  status: string;
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  let userId: string;
  try {
    userId = getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code });
    }
    throw err;
  }

  // userId kept for symmetry with other routes; may be used for audit in future
  void userId;

  const { id } = req.params as { id: string };
  const knex = resolveKnex(req);

  const lookup = await knex.raw(
    `SELECT id, status FROM inventory_transfer WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
  const transfer = (lookup.rows[0] ?? null) as TransferRow | null;
  if (!transfer) {
    return res
      .status(404)
      .json({ error: "Inventory transfer not found", code: "not_found" });
  }
  if (transfer.status !== "shipped") {
    return res.status(409).json({
      error: `Only shipped transfers can be unconfirmed (current status: ${transfer.status})`,
      code: "not_shipped",
    });
  }

  const now = new Date().toISOString();

  await knex.raw(
    `UPDATE inventory_transfer
     SET status = 'confirmed',
         shipped_at = NULL,
         shipped_by_user_id = NULL,
         updated_at = ?
     WHERE id = ?`,
    [now, id]
  );

  const updatedResult = await knex.raw(
    `SELECT * FROM inventory_transfer WHERE id = ?`,
    [id]
  );

  return res.json({ transfer: updatedResult.rows[0] });
}
