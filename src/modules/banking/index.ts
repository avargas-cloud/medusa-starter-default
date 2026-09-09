import { Module } from "@medusajs/utils";

import BankingModuleService from "./service";

export const BANKING_MODULE = "banking";

export default Module(BANKING_MODULE, { service: BankingModuleService });
