import { ModuleProvider, Modules } from "@medusajs/utils";

import UPS2ndDayAirService from "./service";

export default ModuleProvider(Modules.FULFILLMENT, {
  services: [UPS2ndDayAirService],
});
