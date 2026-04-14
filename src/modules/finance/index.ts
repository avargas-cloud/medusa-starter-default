import { Module } from "@medusajs/utils";

import FinanceModuleService from "./service";

export const FINANCE_MODULE = "finance";

export default Module(FINANCE_MODULE, {
  service: FinanceModuleService,
});
