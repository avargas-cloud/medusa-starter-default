/**
 * src/modules/unmet-demand/index.ts
 *
 * Tracks "unmet demand" events — customers who walked in looking for items
 * the store could not fulfill, and (optionally) what they purchased as a
 * substitute. Records are independent of orders so they can also capture
 * walk-outs with no sale.
 *
 * Register in medusa-config.ts as resolve: './src/modules/unmet-demand'.
 */

import { Module } from "@medusajs/utils";

import UnmetDemandModuleService from "./service";

export const UNMET_DEMAND_MODULE = "unmet_demand";

export default Module(UNMET_DEMAND_MODULE, {
  service: UnmetDemandModuleService,
});
