/**
 * src/modules/bill-payments/index.ts
 * Module definition — register in medusa-config.ts as resolve: './src/modules/bill-payments'
 */
import { Module } from "@medusajs/utils";

import BillPaymentsModuleService from "./service";

export const BILL_PAYMENTS_MODULE = "bill_payments";

export default Module(BILL_PAYMENTS_MODULE, {
  service: BillPaymentsModuleService,
});
