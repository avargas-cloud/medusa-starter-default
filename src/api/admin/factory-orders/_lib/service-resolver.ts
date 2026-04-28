import type { AuthenticatedMedusaRequest } from "@medusajs/framework/http";

import { FACTORY_ORDERS_MODULE } from "../../../../modules/factory-orders";
import type FactoryOrdersModuleService from "../../../../modules/factory-orders/service";

export function getFactoryOrdersService(
  req: AuthenticatedMedusaRequest
): FactoryOrdersModuleService {
  return req.scope.resolve(
    FACTORY_ORDERS_MODULE
  ) as unknown as FactoryOrdersModuleService;
}
