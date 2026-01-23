import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import SmartStorageService from "./service"

export default ModuleProvider(Modules.FILE, {
    services: [SmartStorageService],
})
