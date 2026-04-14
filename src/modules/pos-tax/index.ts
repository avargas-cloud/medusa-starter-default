import { ModuleProvider, Modules } from "@medusajs/utils";

import PosTaxProvider from "./service";

export default ModuleProvider(Modules.TAX, {
  services: [PosTaxProvider],
});
