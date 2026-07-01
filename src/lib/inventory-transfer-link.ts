/**
 * Helpers for the "Transfer to USA" inventory accounting.
 *
 * When a PO is linked to an inventory_transfer (origin_country='CN'),
 * receiving/cancelling/voiding that PO must keep China stock in sync:
 *
 *   China available = stocked_quantity − reserved_quantity
 *   reserved_quantity includes pending IT qty as soon as the Transfer is confirmed.
 *
 * These helpers are called from route handlers AFTER the Medusa workflow
 * has already committed (so they only fire on success).
 */

import { CHINA_LOC } from "./locations";
import {
  rebuildTransferChinaReservations,
  releaseTransferChinaReservations,
  releaseTransferLineChinaReservation,
} from "./inventory-transfer-reservations";

type KnexRaw = {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: unknown[]; rowCount?: number }>;
};

interface VariantQty {
  inventory_item_id: string;
  product_variant_id: string;
  qty: number;
}

/**
 * Atomic stock delta on the China warehouse level.
 *
 * CRITICAL: writes `raw_stocked_quantity` (the JSONB BigNumber) alongside the
 * numeric `stocked_quantity`. Medusa's INVENTORY module — and therefore the
 * MeiliSearch doc builder + reconciler — read from the raw_* column, so updating
 * only the numeric column desyncs them (the operator sees phantom China stock
 * that was already deducted). Mirrors `atomic-stock-move.ts`. Negative China is
 * allowed (goods can leave before their replenishing Factory Order is received).
 * Returns the number of rows affected (0 = China level missing).
 */
async function moveChinaStock(
  knex: KnexRaw,
  inventoryItemId: string,
  delta: number,
  now: string
): Promise<number> {
  const res = await knex.raw(
    `UPDATE inventory_level
        SET stocked_quantity = stocked_quantity + ?,
            raw_stocked_quantity = jsonb_build_object(
              'value', (stocked_quantity + ?)::text, 'precision', 20
            ),
            updated_at = ?
      WHERE inventory_item_id = ?
        AND location_id = ?
        AND deleted_at IS NULL`,
    [delta, delta, now, inventoryItemId, CHINA_LOC]
  );
  return res.rowCount ?? 0;
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

  // Every line on a Transfer-to-USA PO (vendor = the China agent) is a China
  // item, so China is decremented for every received line. `moveChinaStock`
  // self-gates: it no-ops when the item has no China level (i.e. it is not a
  // China-warehouse SKU), so a stray non-China line can never over-draw China.
  // We intentionally do NOT gate on IT lines: a transfer PO can legitimately
  // carry China items that were never listed on the IT (historical data-entry
  // gap), and those goods DID leave China — gating them would leave phantom
  // China stock (the exact desync this file exists to prevent).
  for (const line of lines) {
    // The transfer line was reserved when the IT was confirmed. Once units are
    // received, release that reserved qty before deducting physical China stock.
    // (No-op for variants not carrying an IT reservation.)
    await releaseTransferLineChinaReservation(
      knex,
      transfer.id,
      line.product_variant_id,
      line.qty
    );

    // Deduct physical China stock (numeric + raw_ BigNumber columns in lockstep).
    await moveChinaStock(knex, line.inventory_item_id, -line.qty, now);

    // Increment IT line qty_received (no-op if this variant is not on the IT).
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

  // Mirror of onPoReceiveApplied: restore China for every reversed line (goods
  // return to China / go back in transit). moveChinaStock self-gates on China
  // level existence.
  for (const line of lines) {
    // Restore China warehouse inventory (numeric + raw_ BigNumber columns).
    await moveChinaStock(knex, line.inventory_item_id, line.qty, now);

    // Decrement IT line qty_received (floor at 0; no-op if not on the IT).
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

  // Rebuild pending reservations after qty_received is reduced. This restores
  // the reversed quantity as committed China stock for the linked PO again.
  await rebuildTransferChinaReservations(knex, transfer.id, po_id);

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
): Promise<string[]> {
  const transfer = await findLinkedTransfer(knex, po_id, [
    "draft",
    "confirmed",
    "shipped",
    "received",
  ]);
  if (!transfer) return [];

  const now = new Date().toISOString();
  const touchedInventoryItemIds = await releaseTransferChinaReservations(
    knex,
    transfer.id
  );

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

  return touchedInventoryItemIds;
}
