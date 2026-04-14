import { ModuleProvider, Modules } from "@medusajs/utils";

import UberShippingService from "./service";

export default ModuleProvider(Modules.FULFILLMENT, {
  services: [UberShippingService],
});
