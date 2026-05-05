/**
 * Recreate allocations for the still-pending lines on Medusa order 1350.
 *
 * The partial invoice/fulfillment is already correct. These three remaining
 * lines were intentionally left uninvoiced/unfulfilled and should stay
 * allocated until delivery:
 *   - ET2-E24646-144GLD x1
 *   - ET2-E24643-144GLD x2
 *   - MAX-88723BK x3
 *
 * Dry-run:
 *   yarn medusa exec ./src/scripts/fix/fix-order-1350-pending-allocations.ts
 *
 * Apply:
 *   APPLY=1 yarn medusa exec ./src/scripts/fix/fix-order-1350-pending-allocations.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

const ORDER_ID = "order_01KP64PS82JB844N64TFJEWA0X";
const LOCATION_ID = "sloc_01KFS2AV3TAKR141KC2D6JCGTR";
const PENDING_SKUS = new Set([
  "ET2-E24646-144GLD",
  "ET2-E24643-144GLD",
  "MAX-88723BK",
]);

interface PendingLine {
  line_item_id: string;
  variant_id: string | null;
  variant_sku: string;
  quantity: string;
  fulfilled_quantity: string;
  existing_reserved_qty: string;
  existing_reservation_count: string;
  inventory_item_id: string | null;
}

export default async function fixOrder1350PendingAllocations({
  container,
}: ExecArgs) {
  const apply = process.env.APPLY === "1";
  const logger = container.resolve("logger");
  const pg = container.resolve("__pg_connection__") as any;
  const inventoryModule = container.resolve(Modules.INVENTORY) as any;

  logger.info(
    `${apply ? "APPLY" : "DRY-RUN"} allocations repair for order 1350 (${ORDER_ID})`
  );

  const { rows } = (await pg.raw(
    `
    SELECT
      oi.item_id AS line_item_id,
      oli.variant_id,
      oli.variant_sku,
      oi.quantity,
      COALESCE(oi.fulfilled_quantity, 0) AS fulfilled_quantity,
      COALESCE(SUM(ri.quantity), 0) AS existing_reserved_qty,
      COUNT(ri.id) AS existing_reservation_count,
      pvii.inventory_item_id
    FROM order_item oi
    JOIN order_line_item oli ON oli.id = oi.item_id
    LEFT JOIN reservation_item ri ON ri.line_item_id = oi.item_id AND ri.deleted_at IS NULL
    LEFT JOIN product_variant_inventory_item pvii
      ON pvii.variant_id = oli.variant_id AND pvii.deleted_at IS NULL
    WHERE oi.order_id = ?
      AND oi.deleted_at IS NULL
      AND oli.deleted_at IS NULL
      AND oli.variant_sku = ANY(?::text[])
    GROUP BY
      oi.item_id,
      oli.variant_id,
      oli.variant_sku,
      oi.quantity,
      oi.fulfilled_quantity,
      pvii.inventory_item_id
    ORDER BY oli.variant_sku
    `,
    [ORDER_ID, Array.from(PENDING_SKUS)]
  )) as { rows: PendingLine[] };

  if (rows.length !== PENDING_SKUS.size) {
    throw new Error(
      `Expected ${PENDING_SKUS.size} pending SKU rows, found ${rows.length}`
    );
  }

  const toCreate = rows
    .map((line) => {
      const pendingQty = Math.max(
        0,
        Number(line.quantity) - Number(line.fulfilled_quantity)
      );
      return { ...line, pendingQty };
    })
    .filter((line) => line.pendingQty > 0 && Number(line.existing_reserved_qty) === 0);

  logger.info("Current pending allocation state:");
  for (const line of rows) {
    logger.info(
      `  ${line.variant_sku}: qty=${line.quantity}, fulfilled=${line.fulfilled_quantity}, reserved=${line.existing_reserved_qty}, reservations=${line.existing_reservation_count}`
    );
  }

  if (!toCreate.length) {
    logger.info("No missing allocations to create.");
    return;
  }

  for (const line of toCreate) {
    if (!line.inventory_item_id) {
      throw new Error(`No inventory_item_id for ${line.variant_sku}`);
    }
  }

  if (!apply) {
    logger.info(
      `Dry-run only. Would create ${toCreate.length} reservation(s): ${toCreate
        .map((line) => `${line.variant_sku} x${line.pendingQty}`)
        .join(", ")}`
    );
    return;
  }

  const { createReservationsWorkflow } = await import("@medusajs/core-flows");

  for (const line of toCreate) {
    const [invItem] = await inventoryModule.listInventoryItems(
      { id: line.inventory_item_id },
      { select: ["id", "allow_backorder"] }
    );
    if (invItem && !invItem.allow_backorder) {
      await inventoryModule.updateInventoryItems([
        { id: line.inventory_item_id, allow_backorder: true },
      ]);
    }

    const levels = await inventoryModule.listInventoryLevels(
      { inventory_item_id: line.inventory_item_id, location_id: LOCATION_ID },
      { select: ["id"] }
    );
    if (!levels?.length) {
      await inventoryModule.createInventoryLevels([
        {
          inventory_item_id: line.inventory_item_id,
          location_id: LOCATION_ID,
          stocked_quantity: 0,
        },
      ]);
    }

    const { result } = await createReservationsWorkflow(container).run({
      input: {
        reservations: [
          {
            inventory_item_id: line.inventory_item_id,
            location_id: LOCATION_ID,
            quantity: line.pendingQty,
            line_item_id: line.line_item_id,
            allow_backorder: true,
          },
        ],
      },
    });

    logger.info(
      `Created reservation ${result?.[0]?.id ?? "(unknown)"} for ${line.variant_sku} x${line.pendingQty}`
    );
  }
}
