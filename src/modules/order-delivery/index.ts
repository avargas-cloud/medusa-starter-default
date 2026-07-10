/**
 * src/modules/order-delivery/index.ts
 * Register in medusa-config.ts as resolve: './src/modules/order-delivery'.
 *
 * Delivery fulfillment tracking: one row per outbound customer shipment
 * (label bought via Shippo/UPS or Uber dispatch), with an explicit status
 * state machine polled by the refresh-delivery-tracking job. See
 * DELIVERY_FULFILLMENT_INTEGRATION_PLAN.md.
 */

import { Module } from "@medusajs/utils";

import OrderDeliveryModuleService from "./service";

export const ORDER_DELIVERY_MODULE = "order_delivery";

export default Module(ORDER_DELIVERY_MODULE, {
  service: OrderDeliveryModuleService,
});
