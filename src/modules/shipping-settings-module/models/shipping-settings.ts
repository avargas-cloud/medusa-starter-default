import { model } from "@medusajs/utils";

// Define the shipping_settings model to match the existing database table
export const ShippingSettings = model.define("shipping_settings", {
  id: model.id().primaryKey(),
  free_shipping_minimum: model.number(),
  regular_ground_shipping_price: model.number(),
  long_item_ground_shipping_price: model.number(),
  override_ups_ground: model.boolean(),
  created_at: model.dateTime().nullable(),
  updated_at: model.dateTime().nullable(),
});
