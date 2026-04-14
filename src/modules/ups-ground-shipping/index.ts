import { ModuleProvider, Modules } from "@medusajs/utils";

import UPSGroundShippingService from "./service";

export default ModuleProvider(Modules.FULFILLMENT, {
  services: [UPSGroundShippingService],
});
