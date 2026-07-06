/**
 * Shared available-basis math for China inventory adjustments.
 *
 * Single source of truth used by the POST/PATCH endpoints AND the one-off import
 * scripts so the arithmetic can never drift between them.
 *
 * Model (see also `china-line-data.ts`):
 *   stocked   = available_on_shelf + committed + in_transit
 *   reserved  = committed + in_transit
 *   available = stocked − reserved                (the loose shelf being counted)
 *
 * The operator enters ONLY the LOOSE SHELF COUNT (`available`). Both reserved
 * buckets are set aside and NOT counted, so both are added back on top of the
 * operator's number:
 *   - `in_transit` (SHIPPED transfers) already physically left China but stays in
 *     `stocked_quantity` until the USA side receives it.
 *   - `committed`  (CONFIRMED-not-yet-shipped transfers) is physically still in
 *     China but boxed/set aside away from the shelves, so the counter skips it.
 * Both are preserved so that when a transfer later ships/receives, the stocked
 * nets down to exactly the operator's shelf count.
 *
 * Because reserved (committed + in_transit) is constant on both sides during a
 * count, the delta measured in AVAILABLE basis equals the delta in STOCKED basis:
 *   newStocked − currentStocked
 *     = (newAvailable + reserved) − currentStocked
 *     = newAvailable − (currentStocked − reserved)
 *     = newAvailable − oldAvailable
 * so one delta drives both the real `adjustInventory` call and the audit trail.
 */
import { Modules } from "@medusajs/utils";
import { loadChinaReservedByItem, type KnexRaw } from "./china-line-data";

export interface ChinaLevel {
  /** Current China `stocked_quantity` (includes committed + in_transit). */
  stocked: number;
  /** Units reserved by CONFIRMED-not-shipped transfers (boxed, still in China). */
  committed: number;
  /** Units reserved by SHIPPED transfers (already left China). */
  in_transit: number;
}

export interface ChinaAdjustmentMath {
  /** Loose shelf the system believed it had (stocked − committed − in_transit). */
  oldAvailable: number;
  /** Loose-shelf count the operator entered. */
  newAvailable: number;
  /** Delta to apply to stocked (== available-basis delta). */
  delta: number;
  /** Resulting `stocked_quantity` after the adjustment (= newAvailable + reserved). */
  newStocked: number;
  /**
   * True when reserved (committed + in_transit) already exceeds stocked
   * (pre-existing phantom / stale reserved cache = negative available). The
   * adjustment is still correct — flag, never clamp.
   */
  preexistingPhantom: boolean;
}

/**
 * Pure adjustment math for one item. `newAvailable` is the operator's loose-shelf
 * count. Never clamps: a negative oldAvailable is surfaced via `preexistingPhantom`.
 */
export function computeChinaAdjustment(
  level: ChinaLevel,
  newAvailable: number
): ChinaAdjustmentMath {
  const reserved = level.committed + level.in_transit;
  const oldAvailable = level.stocked - reserved;
  const delta = newAvailable - oldAvailable;
  const newStocked = level.stocked + delta; // = newAvailable + reserved
  return {
    oldAvailable,
    newAvailable,
    delta,
    newStocked,
    preexistingPhantom: reserved > level.stocked,
  };
}

export interface InventoryLevelReader {
  listInventoryLevels: (
    filters: Record<string, unknown>,
    options?: { take?: number }
  ) => Promise<Array<{ inventory_item_id: string; stocked_quantity: number }>>;
}

/**
 * Loads current stocked + committed + in_transit for a set of inventory items at
 * the China location. Both reserved buckets are added back on top of the
 * operator's shelf count (see `computeChinaAdjustment`).
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
      committed: reserved.get(id)?.committed ?? 0,
      in_transit: reserved.get(id)?.in_transit ?? 0,
    });
  }
  return map;
}

/** Module id re-export so callers resolve the inventory service consistently. */
export const INVENTORY_MODULE = Modules.INVENTORY;
