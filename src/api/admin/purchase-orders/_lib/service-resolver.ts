/**
 * src/api/admin/purchase-orders/_lib/service-resolver.ts
 *
 * Typed accessor for the Purchase Orders module service.
 */

import type { AuthenticatedMedusaRequest } from "@medusajs/framework/http";

import { PURCHASE_ORDERS_MODULE } from "../../../../modules/purchase-orders";
import type PurchaseOrdersModuleService from "../../../../modules/purchase-orders/service";

export function getPurchaseOrdersService(
  req: AuthenticatedMedusaRequest
): PurchaseOrdersModuleService {
  return req.scope.resolve(
    PURCHASE_ORDERS_MODULE
  ) as unknown as PurchaseOrdersModuleService;
}
