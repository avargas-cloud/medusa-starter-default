import { ModuleProvider, Modules } from "@medusajs/utils";

import StorePickupService from "./service";

export default ModuleProvider(Modules.FULFILLMENT, {
  services: [StorePickupService],
});
