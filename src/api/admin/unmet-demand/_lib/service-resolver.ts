/**
 * src/api/admin/unmet-demand/_lib/service-resolver.ts
 *
 * Typed accessor for the UnmetDemand module service.
 */

import type { AuthenticatedMedusaRequest } from "@medusajs/framework/http";

import { UNMET_DEMAND_MODULE } from "../../../../modules/unmet-demand";
import type UnmetDemandModuleService from "../../../../modules/unmet-demand/service";

export function getUnmetDemandService(
  req: AuthenticatedMedusaRequest
): UnmetDemandModuleService {
  return req.scope.resolve(
    UNMET_DEMAND_MODULE
  ) as unknown as UnmetDemandModuleService;
}
