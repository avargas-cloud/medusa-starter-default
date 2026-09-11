/**
 * src/modules/vendor-credits/service.ts
 *
 * Thin — delegates CRUD to MedusaService framework methods. Every write that
 * carries an invariant (Σ applications ≤ total, ≤ bill balance, period lock,
 * vendor match) goes through `src/lib/vendor-credits/**` over a raw pg
 * client with `SELECT … FOR UPDATE`, never through this service.
 */
import { MedusaService } from "@medusajs/utils";

import { VendorCredit } from "./models/vendor-credit";
import { VendorCreditLine } from "./models/vendor-credit-line";
import { VendorCreditApplication } from "./models/vendor-credit-application";

class VendorCreditsModuleService extends MedusaService({
  VendorCredit,
  VendorCreditLine,
  VendorCreditApplication,
}) {}

export default VendorCreditsModuleService;
