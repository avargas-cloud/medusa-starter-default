import { model } from "@medusajs/framework/utils"

/**
 * Shipping Settings Model
 * 
 * Stores global shipping configuration values:
 * - Free shipping minimum order amount
 * - Regular ground shipping price
 * - Long item ground shipping price (for items with "long" shipping profile)
 */
const ShippingSettings = model.define("shipping_settings", {
    id: model.id().primaryKey(),

    // Minimum order amount to qualify for free shipping (in cents)
    free_shipping_minimum: model.number().default(0),

    // Price for regular ground shipping (in cents)
    regular_ground_shipping_price: model.number().default(0),

    // Price for ground shipping when order contains "long" items (in cents)
    long_item_ground_shipping_price: model.number().default(0),

    // Override UPS Ground Shipping - when false, uses UPS native ground; when true, uses custom pricing
    override_ups_ground: model.boolean().default(false),

    // Timestamps
    created_at: model.dateTime(),
    updated_at: model.dateTime(),
})

export default ShippingSettings
