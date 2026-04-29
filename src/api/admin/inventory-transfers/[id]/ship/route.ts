/**
 * src/api/admin/inventory-transfers/[id]/ship/route.ts
 *
 * POST /admin/inventory-transfers/:id/ship
 *
 * Transitions: confirmed → shipped
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
  if (transfer.status !== "confirmed") {
    return res.status(409).json({
      error: `Only confirmed transfers can be shipped (current status: ${transfer.status})`,
      code: "not_confirmed",
    });
  }

  const body = req.body as {
    shipped_at?: string;
    reference_number?: string;
  };

  const now = new Date().toISOString();
  const shippedAt = body.shipped_at ?? now;

  const updates: string[] = [
    `status = 'shipped'`,
    `shipped_at = ?`,
    `shipped_by_user_id = ?`,
    `updated_at = ?`,
  ];
  const values: unknown[] = [shippedAt, userId, now];

  if (body.reference_number !== undefined) {
    updates.push(`reference_number = ?`);
    values.push(body.reference_number);
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
