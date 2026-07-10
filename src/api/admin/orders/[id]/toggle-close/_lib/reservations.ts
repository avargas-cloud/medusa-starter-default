import { createReservationsWorkflow } from "@medusajs/core-flows";
import { Modules } from "@medusajs/utils";
import { USA_LOC } from "../../../../../../lib/locations";
import { listActiveReservationsRaw } from "../../../../../../lib/reservations";

const LOG_PREFIX = "[toggle-close/reservations]";

export interface NegativeStockItem {
  sku: string;
  variant_id: string;
  available: number;
}

/**
 * Resolve the Miami POS stock location (explicit, never "first row" — with
 * Miami + China Warehouse both live, take:1 could re-hold apartado in China
 * depending on DB ordering). Fails closed (undefined) if USA_LOC is missing.
 */
export async function resolveStockLocation(
  stockLocationModule: any
): Promise<string | undefined> {
  try {
    const locs = await stockLocationModule.listStockLocations(
      { id: USA_LOC },
      { take: 1, select: ["id"] }
    );
    if (!locs?.[0]?.id) {
      console.warn(
        `${LOG_PREFIX} Miami location ${USA_LOC} not found — refusing to guess`
      );
      return undefined;
    }
    return locs[0].id;
  } catch {
    return undefined;
  }
}

/**
 * Delete every reservation attached to the order's line items (idempotent).
 * Reads via RAW SQL — the module's { line_item_id } filter is unreliable in
 * Medusa v2 (may return [] when rows exist), which here would LEAK an active
 * reservation past a close.
 */
export async function releaseAllReservations(
  inventoryModule: any,
  knex: any,
  items: any[]
): Promise<void> {
  for (const item of items || []) {
    try {
      const existing = await listActiveReservationsRaw(knex, item.id);
      if (existing.length) {
        await inventoryModule.deleteReservationItems(existing.map((r) => r.id));
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
 * skipping only the portion already FULFILLED. Invoiced-but-unfulfilled units
 * stay reserved ("apartado") — since 2026-07-10 invoicing no longer releases
 * reservations; only the real fulfillment (pickup/dispatch) consumes them.
 * Used by reopen. Returns items that went negative.
 */
export async function recreateReservationsWithBackorder(opts: {
  scope: any;
  inventoryModule: any;
  remoteQuery: any;
  knex: any;
  locationId: string;
  orderId: string;
  items: any[];
}): Promise<NegativeStockItem[]> {
  const { scope, inventoryModule, remoteQuery, knex, locationId, items } = opts;

  const negativeStockItems: NegativeStockItem[] = [];

  // Release existing reservations first.
  await releaseAllReservations(inventoryModule, knex, items);

  for (const item of items || []) {
    const variantId = item.variant_id;
    if (!variantId) continue;

    const fulfilledQty = Number(item.detail?.fulfilled_quantity || 0);
    const quantity = Math.max(0, Number(item.quantity) - fulfilledQty);
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
