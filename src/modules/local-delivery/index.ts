import { ModuleProvider, Modules } from "@medusajs/utils";

import LocalDeliveryService from "./service";

export default ModuleProvider(Modules.FULFILLMENT, {
  services: [LocalDeliveryService],
});
