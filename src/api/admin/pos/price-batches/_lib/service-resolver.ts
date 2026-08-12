/**
 * src/api/admin/pos/price-batches/_lib/service-resolver.ts
 *
 * Single typed accessor for the PriceChange module service.
 */
import type { MedusaRequest } from "@medusajs/framework/http";

import { PRICE_CHANGE_MODULE } from "../../../../../modules/price-change";
import type PriceChangeModuleService from "../../../../../modules/price-change/service";

export function getPriceChangeService(
  req: MedusaRequest
): PriceChangeModuleService {
  return req.scope.resolve(
    PRICE_CHANGE_MODULE
  ) as unknown as PriceChangeModuleService;
}
