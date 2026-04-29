/**
 * Typed accessor for the Landing Costs module service.
 */

import type { AuthenticatedMedusaRequest } from "@medusajs/framework/http";

import { LANDING_COSTS_MODULE } from "../../../../modules/landing-costs";
import type LandingCostsModuleService from "../../../../modules/landing-costs/service";

export function getLandingCostsService(
  req: AuthenticatedMedusaRequest
): LandingCostsModuleService {
  return req.scope.resolve(
    LANDING_COSTS_MODULE
  ) as unknown as LandingCostsModuleService;
}

export type KnexInstance = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

export function resolveKnex(req: AuthenticatedMedusaRequest): KnexInstance {
  return (req.scope as unknown as { resolve: (k: string) => unknown }).resolve(
    "__pg_connection__"
  ) as KnexInstance;
}
