/**
 * src/api/admin/inventory-transfers/[id]/void/route.ts
 *
 * POST /admin/inventory-transfers/:id/void
 *
 * Transitions: confirmed → voided
 * Side effect: voids the linked PurchaseOrder if present.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getActorUserId, UnauthenticatedError } from "../../../purchase-orders/_lib/auth";
import { releaseTransferChinaReservations } from "../../../../../lib/inventory-transfer-reservations";
import { syncInventoryItemToMeiliSearchWorkflow } from "../../../../../workflows/sync-inventory-item-meilisearch";

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
    `SELECT id, status, linked_purchase_order_id
     FROM inventory_transfer WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
  const transfer = (lookup.rows[0] ?? null) as TransferRow | null;
  if (!transfer) {
    return res
      .status(404)
      .json({ error: "Inventory transfer not found", code: "not_found" });
  }
  const VOIDABLE_STATUSES = ["confirmed", "shipped"];
  if (!VOIDABLE_STATUSES.includes(transfer.status)) {
    return res.status(409).json({
      error: `Only confirmed or shipped transfers can be voided (current status: ${transfer.status})`,
      code: "not_voidable",
    });
  }

  const body = req.body as { void_reason?: string };
  const now = new Date().toISOString();
  const touchedInventoryItemIds = await releaseTransferChinaReservations(
    knex,
    id
  );

  // Void the linked PO if present
  if (transfer.linked_purchase_order_id) {
    await knex.raw(
      `UPDATE purchase_order
       SET status = 'voided', voided_at = NOW(), voided_by_user_id = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL`,
      [userId, now, transfer.linked_purchase_order_id]
    );
  }

  // Void the transfer
  await knex.raw(
    `UPDATE inventory_transfer
     SET status = 'voided',
         voided_at = NOW(),
         voided_by_user_id = ?,
         void_reason = ?,
         updated_at = ?
     WHERE id = ?`,
    [userId, body.void_reason ?? null, now, id]
  );

  await Promise.allSettled(
    touchedInventoryItemIds.map((inventoryItemId) =>
      syncInventoryItemToMeiliSearchWorkflow(req.scope).run({
        input: { inventoryItemId },
      })
    )
  );

  const updatedResult = await knex.raw(
    `SELECT * FROM inventory_transfer WHERE id = ?`,
    [id]
  );

  return res.json({ transfer: updatedResult.rows[0] });
}
