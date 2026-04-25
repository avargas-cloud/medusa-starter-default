import { Module } from "@medusajs/utils";
import PurchasingModuleService from "./service";

export const PURCHASING_MODULE = "purchasing";

export default Module(PURCHASING_MODULE, {
  service: PurchasingModuleService,
});
