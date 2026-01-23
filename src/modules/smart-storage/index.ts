import { Module } from "@medusajs/framework/utils"
import SmartStorageService from "./service"

export default Module("smart-storage", {
    service: SmartStorageService,
})
