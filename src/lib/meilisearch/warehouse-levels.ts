/**
 * Warehouse level maps for the MeiliSearch `inventory` index.
 *
 * WHY THIS FILE EXISTS
 * Two workflows write the same index — `sync-inventory.ts` (full reindex) and
 * `sync-inventory-item-meilisearch.ts` (one item, driven by the PG trigger →
 * reconciler) — and each carried its own copy of this block. The copies drifted:
 * the bulk path stored China availability SIGNED while the per-item path wrapped
 * it in `Math.max(0, …)`. So the value an operator saw depended on which writer
 * touched the row last, and nothing in the code said so.
 *
 * Measured in production 2026-08-19: three SKUs sitting at a real deficit
 * (ECTSK-RFRC1C5A −30, ECTSK-RFRC1C15A −15, EPS-SPR-5DSPL2 −10) all reading 0 on
 * the China Inventory list, because a repair had touched their levels and the
 * per-item path rewrote them through the floor. 55 units of shortfall invisible
 * to the person sizing the replenishment order.
 *
 * THE FLOOR IS THE BUG, NOT A STYLE CHOICE. `.claude/rules/purchasing-po-fo.md`
 * has carried the rule since 2026-07-16: China position is NET, never
 * `GREATEST(0, …)`, because flooring hides the deficit AND double-counts the
 * factory order meant to fill it — the operator under-orders. It came back in
 * through the other door.
 *
 * Screen-level flooring is a different thing and stays where it belongs: the POS
 * stock popover clamps for DISPLAY (`chinaAvailableDisplay`) while keeping the
 * signed value for arithmetic. Index data is arithmetic, so it keeps its sign.
 */

import { CHINA_LOC, USA_LOC } from "../locations";

/** Minimal shape of a Medusa inventory level; the service returns much more. */
export interface InventoryLevelLike {
  inventory_item_id?: string | null;
  stocked_quantity?: number | null;
  reserved_quantity?: number | null;
}

export interface WarehouseLevelMaps {
  /** China availability, SIGNED. A negative value is a real shortfall. */
  chinaStockMap: Map<string, number>;
  /** Miami on-hand. `totalStock` in the index reflects Miami only. */
  miamiStockMap: Map<string, number>;
  /** Miami reserved. `totalReserved` in the index reflects Miami only. */
  miamiReservedMap: Map<string, number>;
}

interface InventoryServiceLike {
  listInventoryLevels: (
    filter: Record<string, unknown>,
    config: Record<string, unknown>
  ) => Promise<InventoryLevelLike[]>;
}

/**
 * China availability for one level: `stocked − reserved`, with its sign.
 *
 * A missing `stocked_quantity` reads as 0 rather than skipping the row: a level
 * that exists with reserved units and no stock IS a shortfall, and dropping it
 * would report 0 for exactly the case worth seeing. Measured before unifying —
 * 0 of 301 China levels have a null on either column — so this cannot move a
 * current value; it only fixes which answer a future null gets.
 */
export const chinaAvailableFrom = (level: InventoryLevelLike): number =>
  (level.stocked_quantity ?? 0) - (level.reserved_quantity ?? 0);

/**
 * Load both warehouses in one place.
 *
 * @param inventoryItemIds  Restrict to these items (the per-item path). Omit to
 *                          load every level (the full reindex).
 */
export async function loadWarehouseLevelMaps(
  inventoryService: InventoryServiceLike,
  inventoryItemIds?: string[]
): Promise<WarehouseLevelMaps> {
  const chinaStockMap = new Map<string, number>();
  const miamiStockMap = new Map<string, number>();
  const miamiReservedMap = new Map<string, number>();

  const scope = inventoryItemIds ? { inventory_item_id: inventoryItemIds } : {};
  const take = { take: 100000 };

  const chinaLevels = await inventoryService.listInventoryLevels(
    { location_id: CHINA_LOC, ...scope },
    take
  );
  for (const level of chinaLevels) {
    if (!level.inventory_item_id) continue;
    chinaStockMap.set(level.inventory_item_id, chinaAvailableFrom(level));
  }

  const miamiLevels = await inventoryService.listInventoryLevels(
    { location_id: USA_LOC, ...scope },
    take
  );
  for (const level of miamiLevels) {
    if (!level.inventory_item_id) continue;
    miamiStockMap.set(level.inventory_item_id, level.stocked_quantity ?? 0);
    miamiReservedMap.set(level.inventory_item_id, level.reserved_quantity ?? 0);
  }

  return { chinaStockMap, miamiStockMap, miamiReservedMap };
}
