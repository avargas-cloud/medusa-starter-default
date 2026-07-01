/**
 * Shared physical-basis math for China inventory adjustments.
 *
 * Single source of truth used by the POST/PATCH endpoints AND the one-off import
 * scripts so the arithmetic can never drift between them.
 *
 * Model (see also `china-line-data.ts`):
 *   stocked          = physical_present_in_china + in_transit
 *   physical_present = available + committed        (committed is physically in China)
 *   available        = stocked − reserved           (reserved = committed + in_transit)
 *
 * The operator enters a PHYSICAL COUNT (what is actually in the warehouse). Only
 * `in_transit` (goods reserved by SHIPPED transfers — already gone but still
 * carried in China `stocked_quantity` until the USA side receives them) is added
 * back on top; `committed` is NOT added because those goods are still physically
 * in China and are already included in the operator's count.
 *
 * Because `in_transit` is constant on both sides of the equation, the delta
 * measured in PHYSICAL basis equals the delta in STOCKED basis:
 *   newStocked − currentStocked
 *     = (newPhysical + inTransit) − currentStocked
 *     = newPhysical − (currentStocked − inTransit)
 *     = newPhysical − oldPhysical
 * so one delta drives both the real `adjustInventory` call and the audit trail.
 */
import { Modules } from "@medusajs/utils";
import { loadChinaReservedByItem, type KnexRaw } from "./china-line-data";

export interface ChinaLevel {
  /** Current China `stocked_quantity` (includes in_transit). */
  stocked: number;
  /** Units reserved by SHIPPED transfers (already left China). */
  in_transit: number;
}

export interface ChinaAdjustmentMath {
  /** Physical present the system believed it had (stocked − in_transit). */
  oldPhysical: number;
  /** Physical count the operator entered. */
  newPhysical: number;
  /** Delta to apply to stocked (== physical-basis delta). */
  delta: number;
  /** Resulting `stocked_quantity` after the adjustment (= newPhysical + in_transit). */
  newStocked: number;
  /**
   * True when SHIPPED reservations already exceed stocked (pre-existing phantom /
   * stale reserved cache). The adjustment is still correct — flag, never clamp.
   */
  preexistingPhantom: boolean;
}

/**
 * Pure adjustment math for one item. `newPhysical` is the operator's physical
 * count. Never clamps: a negative oldPhysical is surfaced via `preexistingPhantom`.
 */
export function computeChinaAdjustment(
  level: ChinaLevel,
  newPhysical: number
): ChinaAdjustmentMath {
  const inTransit = level.in_transit;
  const oldPhysical = level.stocked - inTransit;
  const delta = newPhysical - oldPhysical;
  const newStocked = level.stocked + delta; // = newPhysical + inTransit
  return {
    oldPhysical,
    newPhysical,
    delta,
    newStocked,
    preexistingPhantom: inTransit > level.stocked,
  };
}

export interface InventoryLevelReader {
  listInventoryLevels: (
    filters: Record<string, unknown>,
    options?: { take?: number }
  ) => Promise<Array<{ inventory_item_id: string; stocked_quantity: number }>>;
}

/**
 * Loads current stocked + in_transit for a set of inventory items at the China
 * location. `in_transit` is the SHIPPED-transfer reservation sum (committed is
 * intentionally excluded from the adjustment basis).
 */
export async function loadChinaLevels(
  knex: KnexRaw,
  inventoryService: InventoryLevelReader,
  locationId: string,
  inventoryItemIds: string[]
): Promise<Map<string, ChinaLevel>> {
  const map = new Map<string, ChinaLevel>();
  const ids = Array.from(new Set(inventoryItemIds.filter(Boolean)));
  if (ids.length === 0) return map;

  const levels = await inventoryService.listInventoryLevels(
    { inventory_item_id: ids, location_id: locationId },
    { take: ids.length + 10 }
  );
  const stockByItem = new Map<string, number>(
    levels.map((lvl) => [lvl.inventory_item_id, lvl.stocked_quantity ?? 0])
  );

  const reserved = await loadChinaReservedByItem(knex, ids);

  for (const id of ids) {
    map.set(id, {
      stocked: stockByItem.get(id) ?? 0,
      in_transit: reserved.get(id)?.in_transit ?? 0,
    });
  }
  return map;
}

/** Module id re-export so callers resolve the inventory service consistently. */
export const INVENTORY_MODULE = Modules.INVENTORY;
