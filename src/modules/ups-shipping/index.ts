import { ModuleProvider, Modules } from "@medusajs/utils";

import UPSShippingService from "./service";

export default ModuleProvider(Modules.FULFILLMENT, {
  services: [UPSShippingService],
});
