import { Module } from "@medusajs/utils";

import CreditMemoModuleService from "./service";

export const CREDIT_MEMO_MODULE = "credit_memos";

export default Module(CREDIT_MEMO_MODULE, {
  service: CreditMemoModuleService,
});
