import { Module } from "@medusajs/utils";
import InventoryTransfersModuleService from "./service";

export const INVENTORY_TRANSFERS_MODULE = "inventory_transfers";

export default Module(INVENTORY_TRANSFERS_MODULE, {
  service: InventoryTransfersModuleService,
});
