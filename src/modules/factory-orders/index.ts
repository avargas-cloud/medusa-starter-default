/**
 * src/modules/factory-orders/index.ts
 *
 * Factory Orders — Medusa-only purchasing module for China Warehouse stock.
 * Mirrors the purchase-orders module lifecycle but has no QuickBooks integration.
 *
 * Design rules:
 *   - stock_location_id is always China Warehouse; enforced by the API layer.
 *   - Vendor metadata is sourced from qb_vendor (reused as factory catalog).
 *   - Stock movement applied at receipt time via stock_applied on receipt lines.
 *   - Numbering via dedicated Postgres sequences: FO-{n}, FRCP-{n}, FOD-{n}.
 */

import { Module } from "@medusajs/utils";
import FactoryOrdersModuleService from "./service";

export const FACTORY_ORDERS_MODULE = "factory_orders";

export default Module(FACTORY_ORDERS_MODULE, {
  service: FactoryOrdersModuleService,
});
