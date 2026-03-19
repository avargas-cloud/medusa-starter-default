import { ModuleProvider, Modules } from "@medusajs/utils"
import FileMinioFlatService from "./service"

export default ModuleProvider(Modules.FILE, {
    services: [FileMinioFlatService],
})
