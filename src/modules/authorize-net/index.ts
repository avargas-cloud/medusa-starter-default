import { ModuleProvider, Modules } from "@medusajs/utils";

import AuthorizeNetPaymentService from "./service";

export default ModuleProvider(Modules.PAYMENT, {
  services: [AuthorizeNetPaymentService],
});
