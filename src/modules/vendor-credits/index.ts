/**
 * src/modules/vendor-credits/index.ts
 * Module definition — register in medusa-config.ts as resolve: './src/modules/vendor-credits'
 */
import { Module } from "@medusajs/utils";

import VendorCreditsModuleService from "./service";

export const VENDOR_CREDITS_MODULE = "vendor_credits";

export default Module(VENDOR_CREDITS_MODULE, {
  service: VendorCreditsModuleService,
});
