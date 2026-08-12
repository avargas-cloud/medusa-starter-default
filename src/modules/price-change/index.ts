/**
 * src/modules/price-change/index.ts
 * Module definition — register in medusa-config.ts as resolve: "./src/modules/price-change"
 */

import { Module } from "@medusajs/utils";

import PriceChangeModuleService from "./service";

export const PRICE_CHANGE_MODULE = "price_change";

export default Module(PRICE_CHANGE_MODULE, {
  service: PriceChangeModuleService,
});
