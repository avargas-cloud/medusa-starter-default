import { generateEntityId } from "@medusajs/utils";

import { CHINA_LOC } from "./locations";

type KnexRaw = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

interface TransferLineReservationRow {
  id: string;
  transfer_id: string;
  product_variant_id: string;
  sku: string;
  qty: number;
  qty_received: number;
  inventory_item_id: string;
}

interface ReservationRow {
  id: string;
  quantity: number;
  inventory_item_id: string;
}

const rawQuantity = (quantity: number) =>
  JSON.stringify({ value: String(quantity), precision: 20 });

async function ensureChinaLevels(
  knex: KnexRaw,
  inventoryItemIds: string[]
): Promise<void> {
  const uniqueIds = Array.from(new Set(inventoryItemIds)).filter(Boolean);
  for (const inventoryItemId of uniqueIds) {
    await knex.raw(
      `INSERT INTO inventory_level (
          id, inventory_item_id, location_id,
          stocked_quantity, reserved_quantity, incoming_quantity,
          raw_stocked_quantity, raw_reserved_quantity, raw_incoming_quantity,
          created_at, updated_at
        )
        SELECT ?, ?, ?, 0, 0, 0, ?::jsonb, ?::jsonb, ?::jsonb, NOW(), NOW()
        WHERE NOT EXISTS (
          SELECT 1 FROM inventory_level
          WHERE inventory_item_id = ?
            AND location_id = ?
            AND deleted_at IS NULL
        )`,
      [
        generateEntityId("", "ilev"),
        inventoryItemId,
        CHINA_LOC,
        rawQuantity(0),
        rawQuantity(0),
        rawQuantity(0),
        inventoryItemId,
        CHINA_LOC,
      ]
    );
  }
}

async function getTransferReservationLines(
  knex: KnexRaw,
  transferId: string
): Promise<TransferLineReservationRow[]> {
  const result = await knex.raw(
    `SELECT
        itl.id,
        itl.transfer_id,
        itl.product_variant_id,
        itl.sku,
        itl.qty,
        COALESCE(itl.qty_received, 0) AS qty_received,
        pvii.inventory_item_id
      FROM inventory_transfer_line itl
      JOIN product_variant_inventory_item pvii
        ON pvii.variant_id = itl.product_variant_id
       AND pvii.deleted_at IS NULL
      WHERE itl.transfer_id = ?
        AND itl.deleted_at IS NULL
      ORDER BY itl.created_at ASC`,
    [transferId]
  );
  return result.rows as TransferLineReservationRow[];
}

async function listTransferReservations(
  knex: KnexRaw,
  transferId: string,
  transferLineId?: string
): Promise<ReservationRow[]> {
  const filters = [
    `ri.deleted_at IS NULL`,
    `ri.location_id = ?`,
    `ri.metadata->>'inventory_transfer_id' = ?`,
  ];
  const values: unknown[] = [CHINA_LOC, transferId];
  if (transferLineId) {
    filters.push(`ri.metadata->>'inventory_transfer_line_id' = ?`);
    values.push(transferLineId);
  }

  const result = await knex.raw(
    `SELECT id, quantity, inventory_item_id
       FROM reservation_item ri
      WHERE ${filters.join(" AND ")}
      ORDER BY created_at ASC`,
    values
  );
  return result.rows as ReservationRow[];
}

async function adjustChinaReserved(
  knex: KnexRaw,
  inventoryItemId: string,
  delta: number
): Promise<void> {
  if (delta === 0) return;
  await knex.raw(
    `UPDATE inventory_level
        SET reserved_quantity = GREATEST(0, reserved_quantity + ?),
            raw_reserved_quantity = jsonb_build_object(
              'value',
              GREATEST(0, reserved_quantity + ?)::text,
              'precision',
              20
            ),
            updated_at = NOW()
      WHERE inventory_item_id = ?
        AND location_id = ?
        AND deleted_at IS NULL`,
    [delta, delta, inventoryItemId, CHINA_LOC]
  );
}

/**
 * Rebuilds China reservations for the unreceived qty on a transfer.
 * This is intentionally idempotent: existing IT reservations are released,
 * then recreated from current active lines.
 */
export async function rebuildTransferChinaReservations(
  knex: KnexRaw,
  transferId: string,
  purchaseOrderId: string | null
): Promise<string[]> {
  const releasedInventoryItemIds = await releaseTransferChinaReservations(
    knex,
    transferId
  );

  const lines = await getTransferReservationLines(knex, transferId);
  const inventoryItemIds = lines.map((line) => line.inventory_item_id);
  await ensureChinaLevels(knex, inventoryItemIds);

  const touched = new Set<string>(releasedInventoryItemIds);
  for (const line of lines) {
    const pendingQty = Math.max(0, Number(line.qty) - Number(line.qty_received));
    if (pendingQty <= 0) continue;

    touched.add(line.inventory_item_id);
    await knex.raw(
      `INSERT INTO reservation_item (
          id, line_item_id, location_id, quantity, external_id, description,
          created_by, metadata, inventory_item_id, allow_backorder,
          raw_quantity, created_at, updated_at
        ) VALUES (
          ?, NULL, ?, ?, ?, ?, NULL, ?::jsonb, ?, TRUE, ?::jsonb, NOW(), NOW()
        )`,
      [
        generateEntityId("", "resitem"),
        CHINA_LOC,
        pendingQty,
        `inventory-transfer:${line.id}`,
        `Transfer to USA ${line.sku}`,
        JSON.stringify({
          source: "inventory_transfer",
          inventory_transfer_id: transferId,
          inventory_transfer_line_id: line.id,
          purchase_order_id: purchaseOrderId,
          product_variant_id: line.product_variant_id,
          sku: line.sku,
        }),
        line.inventory_item_id,
        rawQuantity(pendingQty),
      ]
    );
    await adjustChinaReserved(knex, line.inventory_item_id, pendingQty);
  }

  return Array.from(touched);
}

/** Releases every active China reservation owned by a transfer. */
export async function releaseTransferChinaReservations(
  knex: KnexRaw,
  transferId: string
): Promise<string[]> {
  const reservations = await listTransferReservations(knex, transferId);
  const touched = new Set<string>();

  for (const reservation of reservations) {
    touched.add(reservation.inventory_item_id);
    await knex.raw(
      `UPDATE reservation_item
          SET deleted_at = NOW(), updated_at = NOW()
        WHERE id = ?
          AND deleted_at IS NULL`,
      [reservation.id]
    );
    await adjustChinaReserved(
      knex,
      reservation.inventory_item_id,
      -Number(reservation.quantity)
    );
  }

  return Array.from(touched);
}

/**
 * Releases a partial quantity from one transfer line reservation.
 * Used when a linked PO receipt is applied: received units leave China, so they
 * are no longer merely reserved.
 */
export async function releaseTransferLineChinaReservation(
  knex: KnexRaw,
  transferId: string,
  productVariantId: string,
  quantity: number
): Promise<string[]> {
  if (quantity <= 0) return [];

  const lineResult = await knex.raw(
    `SELECT id
       FROM inventory_transfer_line
      WHERE transfer_id = ?
        AND product_variant_id = ?
        AND deleted_at IS NULL
      LIMIT 1`,
    [transferId, productVariantId]
  );
  const line = lineResult.rows[0] as { id: string } | undefined;
  if (!line) return [];

  let remaining = quantity;
  const touched = new Set<string>();
  const reservations = await listTransferReservations(knex, transferId, line.id);

  for (const reservation of reservations) {
    if (remaining <= 0) break;
    const currentQty = Number(reservation.quantity);
    const releaseQty = Math.min(currentQty, remaining);
    const nextQty = currentQty - releaseQty;

    touched.add(reservation.inventory_item_id);
    if (nextQty <= 0) {
      await knex.raw(
        `UPDATE reservation_item
            SET deleted_at = NOW(), updated_at = NOW()
          WHERE id = ?
            AND deleted_at IS NULL`,
        [reservation.id]
      );
    } else {
      await knex.raw(
        `UPDATE reservation_item
            SET quantity = ?,
                raw_quantity = ?::jsonb,
                updated_at = NOW()
          WHERE id = ?
            AND deleted_at IS NULL`,
        [nextQty, rawQuantity(nextQty), reservation.id]
      );
    }

    await adjustChinaReserved(knex, reservation.inventory_item_id, -releaseQty);
    remaining -= releaseQty;
  }

  return Array.from(touched);
}
