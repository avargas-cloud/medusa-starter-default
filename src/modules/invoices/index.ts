/**
 * src/modules/invoices/index.ts
 * Module definition — register in medusa-config.ts as resolve: './src/modules/invoices'
 */

import { Module } from "@medusajs/utils";

import InvoiceModuleService from "./service";

export const INVOICE_MODULE = "invoices";

export default Module(INVOICE_MODULE, {
  service: InvoiceModuleService,
});
