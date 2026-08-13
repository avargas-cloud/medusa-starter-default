/**
 * src/modules/places-usage/index.ts
 * Module definition — register in medusa-config.ts as resolve: "./src/modules/places-usage"
 */

import { Module } from "@medusajs/utils";

import PlacesUsageModuleService from "./service";

export const PLACES_USAGE_MODULE = "places_usage";

export default Module(PLACES_USAGE_MODULE, {
  service: PlacesUsageModuleService,
});
