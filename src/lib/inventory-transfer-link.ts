/**
 * Helpers for the "Transfer to USA" inventory accounting.
 *
 * When a PO is linked to an inventory_transfer (origin_country='CN'),
 * receiving/cancelling/voiding that PO must keep China stock in sync:
 *
 *   China available = stocked_quantity − SUM(shipped_in_transit)
 *   shipped_in_transit = itl.qty − itl.qty_received  (IT.status = 'shipped')
 *
 * These helpers are called from route handlers AFTER the Medusa workflow
 * has already committed (so they only fire on success).
 */

import { CHINA_LOC } from "./locations";

type KnexRaw = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

interface VariantQty {
  inventory_item_id: string;
  product_variant_id: string;
  qty: number;
}

interface LinkedTransferRow {
  id: string;
  status: string;
}

/** Lookup the active IT linked to a PO (shipped or received states). */
async function findLinkedTransfer(
  knex: KnexRaw,
  po_id: string,
  statusIn: string[]
): Promise<LinkedTransferRow | null> {
  const placeholders = statusIn.map(() => "?").join(", ");
  const result = await knex.raw(
    `SELECT id, status FROM inventory_transfer
      WHERE linked_purchase_order_id = ?
        AND status IN (${placeholders})
        AND deleted_at IS NULL
      LIMIT 1`,
    [po_id, ...statusIn]
  );
  return (result.rows[0] ?? null) as LinkedTransferRow | null;
}

/**
 * Called when a PO receipt is APPLIED (receive).
 *
 * For each received variant:
 *   1. Deducts qty from China stocked_quantity (goods physically confirmed at USA).
 *   2. Increments inventory_transfer_line.qty_received.
 *
 * If all IT lines are now fully received → transitions IT to 'received'.
 */
export async function onPoReceiveApplied(
  knex: KnexRaw,
  po_id: string,
  lines: VariantQty[]
): Promise<void> {
  const transfer = await findLinkedTransfer(knex, po_id, ["shipped"]);
  if (!transfer) return;

  const now = new Date().toISOString();

  for (const line of lines) {
    // Deduct from China warehouse inventory
    await knex.raw(
      `UPDATE inventory_level
          SET stocked_quantity = stocked_quantity - ?,
              updated_at       = ?
        WHERE inventory_item_id = ?
          AND location_id       = ?
          AND deleted_at IS NULL`,
      [line.qty, now, line.inventory_item_id, CHINA_LOC]
    );

    // Increment IT line qty_received (cap at qty to stay within constraint)
    await knex.raw(
      `UPDATE inventory_transfer_line
          SET qty_received = LEAST(qty, qty_received + ?),
              updated_at   = ?
        WHERE transfer_id       = ?
          AND product_variant_id = ?
          AND deleted_at IS NULL`,
      [line.qty, now, transfer.id, line.product_variant_id]
    );
  }

  // Transition IT to 'received' when all lines are fully accounted for
  const unreceivedResult = await knex.raw(
    `SELECT COUNT(*)::int AS cnt
       FROM inventory_transfer_line
      WHERE transfer_id = ?
        AND deleted_at IS NULL
        AND qty_received < qty`,
    [transfer.id]
  );
  const unreceivedCount = (unreceivedResult.rows[0] as { cnt: number }).cnt;
  if (unreceivedCount === 0) {
    await knex.raw(
      `UPDATE inventory_transfer
          SET status      = 'received',
              received_at = ?,
              updated_at  = ?
        WHERE id = ?`,
      [now, now, transfer.id]
    );
  }
}

/**
 * Called when a PO receipt is REVERSED (delete receipt).
 *
 * For each reversed variant:
 *   1. Adds qty back to China stocked_quantity (goods back in transit).
 *   2. Decrements inventory_transfer_line.qty_received.
 *
 * If IT was already 'received', reverts it to 'shipped' (partial un-receive).
 */
export async function onPoReceiveReversed(
  knex: KnexRaw,
  po_id: string,
  lines: VariantQty[]
): Promise<void> {
  const transfer = await findLinkedTransfer(knex, po_id, ["shipped", "received"]);
  if (!transfer) return;

  const now = new Date().toISOString();

  for (const line of lines) {
    // Restore China warehouse inventory
    await knex.raw(
      `UPDATE inventory_level
          SET stocked_quantity = stocked_quantity + ?,
              updated_at       = ?
        WHERE inventory_item_id = ?
          AND location_id       = ?
          AND deleted_at IS NULL`,
      [line.qty, now, line.inventory_item_id, CHINA_LOC]
    );

    // Decrement IT line qty_received (floor at 0)
    await knex.raw(
      `UPDATE inventory_transfer_line
          SET qty_received = GREATEST(0, qty_received - ?),
              updated_at   = ?
        WHERE transfer_id       = ?
          AND product_variant_id = ?
          AND deleted_at IS NULL`,
      [line.qty, now, transfer.id, line.product_variant_id]
    );
  }

  // Revert IT to 'shipped' if it had reached 'received'
  if (transfer.status === "received") {
    await knex.raw(
      `UPDATE inventory_transfer
          SET status      = 'shipped',
              received_at = NULL,
              updated_at  = ?
        WHERE id = ?`,
      [now, transfer.id]
    );
  }
}

/**
 * Called when a PO is VOIDED.
 *
 * Voids the linked IT (if any, regardless of status).
 * No stock change: unreceived units were never deducted from China;
 * already-received units are correctly sitting in the USA warehouse.
 */
export async function onPoVoided(
  knex: KnexRaw,
  po_id: string,
  voided_by_user_id: string
): Promise<void> {
  const transfer = await findLinkedTransfer(knex, po_id, [
    "draft",
    "confirmed",
    "shipped",
    "received",
  ]);
  if (!transfer) return;

  const now = new Date().toISOString();
  await knex.raw(
    `UPDATE inventory_transfer
        SET status             = 'voided',
            voided_at          = ?,
            voided_by_user_id  = ?,
            void_reason        = 'PO voided',
            updated_at         = ?
      WHERE id = ?`,
    [now, voided_by_user_id, now, transfer.id]
  );
}
