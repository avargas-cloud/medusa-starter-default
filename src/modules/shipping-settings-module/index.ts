import { Module } from "@medusajs/utils"
import ShippingSettingsModuleService from "./service"

export const SHIPPING_SETTINGS_MODULE = "shippingSettingsModule"

export default Module(SHIPPING_SETTINGS_MODULE, {
    service: ShippingSettingsModuleService,
})
