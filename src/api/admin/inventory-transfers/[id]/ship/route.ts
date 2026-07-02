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
import {
  PO_STATUS_AUTOSHIP_BLOCKED_LIFECYCLE,
  resolveShippedPoStatus,
} from "../../../purchase-orders/_lib/po-shipping-status";

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

interface LinkedPoRow {
  status: string;
  po_status: string | null;
  tracking: unknown;
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
    `SELECT id, status, linked_purchase_order_id FROM inventory_transfer WHERE id = ? AND deleted_at IS NULL`,
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

  // When the transfer ships, advance the linked PO's workflow status.
  // Tracking-aware: with a tracking number the shipment is watchable →
  // "Shipped (Waiting on Arrival)"; otherwise → "Shipped (Missing Tracking)".
  // Idempotent + non-fatal, skipped once the PO has arrived / is dead.
  if (transfer.linked_purchase_order_id) {
    try {
      const poLookup = await knex.raw(
        `SELECT status, po_status, tracking FROM purchase_order WHERE id = ? AND deleted_at IS NULL`,
        [transfer.linked_purchase_order_id]
      );
      const po = (poLookup.rows[0] ?? null) as LinkedPoRow | null;
      if (po && !PO_STATUS_AUTOSHIP_BLOCKED_LIFECYCLE.includes(po.status)) {
        const hasTracking =
          Array.isArray(po.tracking) && po.tracking.length > 0;
        const nextPoStatus = resolveShippedPoStatus(hasTracking);
        if (po.po_status !== nextPoStatus) {
          await knex.raw(
            `UPDATE purchase_order SET po_status = ?, updated_at = ? WHERE id = ?`,
            [nextPoStatus, now, transfer.linked_purchase_order_id]
          );
        }
      }
    } catch {
      /* non-fatal — the transfer is already shipped */
    }
  }

  const updatedResult = await knex.raw(
    `SELECT * FROM inventory_transfer WHERE id = ?`,
    [id]
  );

  return res.json({ transfer: updatedResult.rows[0] });
}
