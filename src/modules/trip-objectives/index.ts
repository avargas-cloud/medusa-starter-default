/**
 * src/modules/trip-objectives/index.ts
 * Register in medusa-config.ts as resolve: './src/modules/trip-objectives'.
 *
 * China-trip objective tracker: trips → categories (Sourcing/Negotiation/
 * Decisions, each with its own dynamic field_schema + status pipeline) →
 * objectives (structured per-type fields + reference image) → dated
 * observations. POS-only, accounting-gated.
 */

import { Module } from "@medusajs/utils";

import TripObjectivesModuleService from "./service";

export const TRIP_OBJECTIVES_MODULE = "trip_objectives";

export default Module(TRIP_OBJECTIVES_MODULE, {
  service: TripObjectivesModuleService,
});
