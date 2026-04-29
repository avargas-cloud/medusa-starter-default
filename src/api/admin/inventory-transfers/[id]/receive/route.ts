/**
 * src/api/admin/inventory-transfers/[id]/receive/route.ts
 *
 * POST /admin/inventory-transfers/:id/receive
 *
 * Transitions: shipped → received
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
      error: `Only shipped transfers can be received (current status: ${transfer.status})`,
      code: "not_shipped",
    });
  }

  const body = req.body as {
    received_at?: string;
    notes?: string;
  };

  const now = new Date().toISOString();
  const receivedAt = body.received_at ?? now;

  const updates: string[] = [
    `status = 'received'`,
    `received_at = ?`,
    `received_by_user_id = ?`,
    `updated_at = ?`,
  ];
  const values: unknown[] = [receivedAt, userId, now];

  if (body.notes !== undefined) {
    updates.push(`notes = ?`);
    values.push(body.notes);
  }

  values.push(id);

  await knex.raw(
    `UPDATE inventory_transfer SET ${updates.join(", ")} WHERE id = ?`,
    values
  );

  const updatedResult = await knex.raw(
    `SELECT * FROM inventory_transfer WHERE id = ?`,
    [id]
  );

  return res.json({ transfer: updatedResult.rows[0] });
}
