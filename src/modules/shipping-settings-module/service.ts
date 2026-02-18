import { MedusaService } from "@medusajs/framework/utils"
import { ShippingSettings } from "./models/shipping-settings"

// Create service using MedusaService factory
export default class ShippingSettingsModuleService extends MedusaService({
    ShippingSettings,
}) { }
