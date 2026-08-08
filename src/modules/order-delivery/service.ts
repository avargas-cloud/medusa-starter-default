/**
 * src/modules/order-delivery/service.ts
 *
 * Auto-CRUD over the order_delivery model. Ids use the `odel_` prefix.
 * Business logic (create-shipment orchestration, status transitions) lives in
 * api routes + lib/shipping-dispatch, not here.
 */

import { MedusaService } from "@medusajs/utils";

import { OrderDelivery } from "./models/order-delivery";
import { OrderDeliveryLine } from "./models/order-delivery-line";

class OrderDeliveryModuleService extends MedusaService({
  OrderDelivery,
  OrderDeliveryLine,
}) {}

export default OrderDeliveryModuleService;
