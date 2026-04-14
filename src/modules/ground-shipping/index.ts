import { ModuleProvider, Modules } from "@medusajs/utils";

import GroundShippingService from "./service";

export default ModuleProvider(Modules.FULFILLMENT, {
  services: [GroundShippingService],
});
