import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import FileMinioFlatService from "./service"

export default ModuleProvider(Modules.FILE, {
    services: [FileMinioFlatService],
})
