import { ModuleProvider, Modules } from "@medusajs/utils";

import UPSNextDayAirService from "./service";

export default ModuleProvider(Modules.FULFILLMENT, {
  services: [UPSNextDayAirService],
});
