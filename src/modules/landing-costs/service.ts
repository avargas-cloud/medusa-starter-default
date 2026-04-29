/**
 * src/modules/landing-costs/service.ts
 *
 * Thin wrapper around the LandingCost + LandingCostLine models. No
 * sequences — IDs come from the model.id() ULID prefix.
 */

import { MedusaService } from "@medusajs/utils";

import { LandingCost } from "./models/landing-cost";
import { LandingCostLine } from "./models/landing-cost-line";

class LandingCostsModuleService extends MedusaService({
  LandingCost,
  LandingCostLine,
}) {}

export default LandingCostsModuleService;
