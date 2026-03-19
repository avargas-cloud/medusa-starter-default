import PosTaxProvider from "./service"
import { ModuleProvider, Modules } from "@medusajs/utils"

export default ModuleProvider(Modules.TAX, {
    services: [PosTaxProvider],
})
