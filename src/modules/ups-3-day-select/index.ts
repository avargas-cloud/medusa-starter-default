import { ModuleProvider, Modules } from "@medusajs/utils";

import UPS3DaySelectService from "./service";

export default ModuleProvider(Modules.FULFILLMENT, {
  services: [UPS3DaySelectService],
});
