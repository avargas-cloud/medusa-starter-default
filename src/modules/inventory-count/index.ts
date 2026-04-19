/**
 * src/modules/inventory-count/index.ts
 * Module definition — register in medusa-config.ts as resolve: './src/modules/inventory-count'
 *
 * Stores physical inventory count drafts, immutable submitted snapshots,
 * manager approval audit trail, and the QB InventoryAdjustment sync pipeline.
 *
 * Storage rule: deltas, NOT absolute counted quantities. Snapshots are frozen
 * at submit time; the projected-negative guard runs at approval time using
 * live stock to decide whether each line is safe to apply.
 */

import { Module } from "@medusajs/utils";

import InventoryCountModuleService from "./service";

export const INVENTORY_COUNT_MODULE = "inventory_count";

export default Module(INVENTORY_COUNT_MODULE, {
  service: InventoryCountModuleService,
});
