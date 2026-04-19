/**
 * src/api/admin/inventory-counts/_lib/service-resolver.ts
 *
 * Single typed accessor for the InventoryCount module service. Routes call
 * `getInventoryCountService(req)` to avoid sprinkling `as unknown as ...`
 * casts throughout the endpoints.
 */

import type { AuthenticatedMedusaRequest } from "@medusajs/framework/http";

import { INVENTORY_COUNT_MODULE } from "../../../../modules/inventory-count";
import type InventoryCountModuleService from "../../../../modules/inventory-count/service";

export function getInventoryCountService(
  req: AuthenticatedMedusaRequest
): InventoryCountModuleService {
  return req.scope.resolve(
    INVENTORY_COUNT_MODULE
  ) as unknown as InventoryCountModuleService;
}
