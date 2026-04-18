/**
 * src/modules/quickbooks-catalog/index.ts
 * Module definition — register in medusa-config.ts as resolve: './src/modules/quickbooks-catalog'
 *
 * Stores QuickBooks Chart of Accounts, Vendors, and Item pipeline state
 * locally so the POS item creation flow can populate dropdowns without
 * round-tripping to the bridge on every modal open.
 */

import { Module } from "@medusajs/utils";

import QuickbooksCatalogModuleService from "./service";

export const QUICKBOOKS_CATALOG_MODULE = "quickbooks_catalog";

export default Module(QUICKBOOKS_CATALOG_MODULE, {
  service: QuickbooksCatalogModuleService,
});
