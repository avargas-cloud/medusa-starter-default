import UPS2ndDayAirService from "./service";
import { ModuleProvider, Modules } from "@medusajs/utils";

export default ModuleProvider(Modules.FULFILLMENT, {
  services: [UPS2ndDayAirService],
});
