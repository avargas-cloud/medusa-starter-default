import UPSGroundShippingService from "./service"
import { ModuleProvider, Modules } from "@medusajs/utils"

export default ModuleProvider(Modules.FULFILLMENT, {
    services: [UPSGroundShippingService],
})
