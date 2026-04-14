import { ModuleProvider, Modules } from "@medusajs/utils";

import SmartStorageService from "./service";

export default ModuleProvider(Modules.FILE, {
  services: [SmartStorageService],
});
