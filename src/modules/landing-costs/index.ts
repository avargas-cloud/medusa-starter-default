/**
 * src/modules/landing-costs/index.ts
 *
 * Standalone "Landing Cost Calculator" module — a what-if pricing tool for
 * estimating the final landed unit cost of goods (commission + freight by
 * CBM + tariff by cost). Has no relationship to PurchaseOrder, Receipt,
 * Inventory, or QuickBooks.
 */

import { Module } from "@medusajs/utils";

import LandingCostsModuleService from "./service";

export const LANDING_COSTS_MODULE = "landing_costs";

export default Module(LANDING_COSTS_MODULE, {
  service: LandingCostsModuleService,
});
