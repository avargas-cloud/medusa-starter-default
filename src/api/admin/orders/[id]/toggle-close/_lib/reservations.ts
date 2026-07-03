import { createReservationsWorkflow } from "@medusajs/core-flows";
import { Modules } from "@medusajs/utils";

const LOG_PREFIX = "[toggle-close/reservations]";

export interface NegativeStockItem {
  sku: string;
  variant_id: string;
  available: number;
}

/** Resolve the first (only) stock location, or undefined if none exists. */
export async function resolveStockLocation(
  stockLocationModule: any
): Promise<string | undefined> {
  try {
    const locs = await stockLocationModule.listStockLocations(
      {},
      { take: 1, select: ["id"] }
    );
    return locs?.[0]?.id;
  } catch {
    return undefined;
  }
}

/** Delete every reservation attached to the order's line items (idempotent). */
export async function releaseAllReservations(
  inventoryModule: any,
  items: any[]
): Promise<void> {
  for (const item of items || []) {
    try {
      const existing = await inventoryModule.listReservationItems({
        line_item_id: item.id,
      });
      if (existing?.length) {
        await inventoryModule.deleteReservationItems(
          existing.map((r: any) => r.id)
        );
        console.log(
          `${LOG_PREFIX} 🗑️ Released ${existing.length} reservation(s) for item ${item.id}`
        );
      }
    } catch (err: any) {
      console.warn(
        `${LOG_PREFIX} Failed to release reservations for ${item.id}: ${err.message}`
      );
    }
  }
}

/**
 * Release then recreate reservations for the order with allow_backorder=true,
 * skipping the portion already fulfilled or invoiced. Used by the POS-flag close
 * (order held, not completed) and by reopen. Returns items that went negative.
 */
export async function recreateReservationsWithBackorder(opts: {
  scope: any;
  inventoryModule: any;
  remoteQuery: any;
  pg: any;
  locationId: string;
  orderId: string;
  items: any[];
}): Promise<NegativeStockItem[]> {
  const { scope, inventoryModule, remoteQuery, pg, locationId, orderId, items } =
    opts;

  const negativeStockItems: NegativeStockItem[] = [];

  // Release existing reservations first.
  await releaseAllReservations(inventoryModule, items);

  // Pre-fetch invoiced quantities so we skip items already fully invoiced
  // (guard against re-leaking reservations for invoiced work).
  const invoicedQtyMap = new Map<string, number>();
  try {
    const { rows: invRows } = await pg.raw(
      `SELECT pii.variant_id, COALESCE(SUM(pii.quantity), 0) AS invoiced_qty
         FROM pos_invoice_item pii
         JOIN pos_invoice pi ON pi.id = pii.invoice_id
        WHERE pi.order_id = ? AND pi.status != 'voided'
          AND pi.deleted_at IS NULL AND pii.deleted_at IS NULL
        GROUP BY pii.variant_id`,
      [orderId]
    );
    for (const row of invRows) {
      invoicedQtyMap.set(row.variant_id, Number(row.invoiced_qty));
    }
  } catch (mapErr: any) {
    console.warn(
      `${LOG_PREFIX} Could not fetch invoiced quantities: ${mapErr.message}`
    );
  }

  for (const item of items || []) {
    const variantId = item.variant_id;
    if (!variantId) continue;

    const fulfilledQty = Number(item.detail?.fulfilled_quantity || 0);
    const invoicedQty = invoicedQtyMap.get(variantId) ?? 0;
    const alreadyDone = Math.max(fulfilledQty, invoicedQty);
    const quantity = Math.max(0, Number(item.quantity) - alreadyDone);
    if (quantity === 0) continue;

    try {
      let inventoryItemId: string | undefined;
      try {
        const variantData = await remoteQuery({
          variant: {
            fields: ["id"],
            __args: { filters: { id: variantId } },
            inventory_items: { fields: ["inventory_item_id"] },
          },
        });
        inventoryItemId =
          variantData?.[0]?.inventory_items?.[0]?.inventory_item_id;
      } catch {}

      if (!inventoryItemId) continue;

      // Ensure allow_backorder=true so a 0-stock reservation still goes through.
      try {
        const [invItem] = await inventoryModule.listInventoryItems(
          { id: inventoryItemId },
          { select: ["id", "allow_backorder"] }
        );
        if (invItem && !invItem.allow_backorder) {
          await inventoryModule.updateInventoryItems([
            { id: inventoryItemId, allow_backorder: true },
          ]);
        }
      } catch {}

      // Ensure an inventory level exists; report if this reservation goes negative.
      try {
        const levels = await inventoryModule.listInventoryLevels(
          { inventory_item_id: inventoryItemId, location_id: locationId },
          { select: ["id", "stocked_quantity", "reserved_quantity"] }
        );
        if (!levels?.length) {
          await inventoryModule.createInventoryLevels([
            {
              inventory_item_id: inventoryItemId,
              location_id: locationId,
              stocked_quantity: 0,
            },
          ]);
        } else {
          const level = levels[0];
          const available =
            Number(level.stocked_quantity) -
            Number(level.reserved_quantity) -
            quantity;
          if (available < 0) {
            negativeStockItems.push({
              sku: item.variant?.sku || variantId,
              variant_id: variantId,
              available,
            });
          }
        }
      } catch {}

      await createReservationsWorkflow(scope).run({
        input: {
          reservations: [
            {
              inventory_item_id: inventoryItemId,
              location_id: locationId,
              quantity,
              line_item_id: item.id,
              allow_backorder: true,
            },
          ],
        },
      });
      console.log(
        `${LOG_PREFIX} ✅ Reserved ${quantity}× for variant ${variantId}`
      );
    } catch (err: any) {
      console.warn(
        `${LOG_PREFIX} Reservation failed for ${variantId}: ${err.message?.slice(0, 100)}`
      );
    }
  }

  return negativeStockItems;
}

/** Convenience: get the inventory + stock-location modules from the request scope. */
export function getInventoryModules(scope: any) {
  return {
    inventoryModule: scope.resolve(Modules.INVENTORY) as any,
    stockLocationModule: scope.resolve(Modules.STOCK_LOCATION) as any,
  };
}
