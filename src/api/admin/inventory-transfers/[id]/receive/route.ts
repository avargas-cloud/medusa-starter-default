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
  linked_purchase_order_id: string | null;
  po_number: string | null;
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
    `SELECT it.id, it.status, it.linked_purchase_order_id, po.number AS po_number
       FROM inventory_transfer it
       LEFT JOIN purchase_order po ON po.id = it.linked_purchase_order_id
      WHERE it.id = ? AND it.deleted_at IS NULL`,
    [id]
  );
  const transfer = (lookup.rows[0] ?? null) as TransferRow | null;
  if (!transfer) {
    return res
      .status(404)
      .json({ error: "Inventory transfer not found", code: "not_found" });
  }

  // This route only flips a status: it does not debit China stock, release the
  // transfer's China reservations, or bump qty_received. For a standalone IT
  // that is the whole job. For an IT backed by a PO it is a trapdoor — the item
  // receipt is the sole authority on what arrived, and closing the transfer
  // here would make onPoReceiveApplied treat every later receipt as a no-op,
  // stranding China stock exactly like the 'shipped'-only gate did.
  //
  // Latent, not historical: audited 2026-08-19, all 20 received transfers in
  // production carry received_by_user_id = NULL, which only the PO receipt path
  // leaves — this route has never actually run against a linked IT, and the POS
  // already deep-links its "Receive via PO" button to the order. The guard shuts
  // the door before someone finds it, and costs nothing today.
  if (transfer.linked_purchase_order_id) {
    return res.status(409).json({
      error: transfer.po_number
        ? `This transfer is received by receiving ${transfer.po_number}, not from here — that is what moves the goods out of China.`
        : "This transfer is received by receiving its linked purchase order, not from here — that is what moves the goods out of China.",
      code: "linked_po_receive_required",
      purchase_order_id: transfer.linked_purchase_order_id,
      purchase_order_number: transfer.po_number,
    });
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
