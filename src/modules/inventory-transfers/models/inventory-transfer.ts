import { model } from "@medusajs/utils";

export const InventoryTransfer = model.define("inventory_transfer", {
  id: model.id({ prefix: "it" }).primaryKey(),
  number: model.text().nullable(),
  seq: model.number().nullable(),

  status: model.text().default("draft"),

  origin_country: model.text().default("CN"),
  destination_location_id: model.text(),

  vendor_id: model.text().nullable(),
  vendor_name_snapshot: model.text().nullable(),

  linked_purchase_order_id: model.text().nullable(),

  reference_number: model.text().nullable(),
  tracking_number: model.text().nullable(),
  shipper: model.text().nullable(), // ups | fedex | dhl | other
  notes: model.text().nullable(),

  expected_arrival_at: model.dateTime().nullable(),

  total_lines: model.number().default(0),
  total_units: model.number().default(0),
  subtotal_cents: model.number().default(0),

  created_by_user_id: model.text(),

  confirmed_at: model.dateTime().nullable(),
  confirmed_by_user_id: model.text().nullable(),

  shipped_at: model.dateTime().nullable(),
  shipped_by_user_id: model.text().nullable(),

  received_at: model.dateTime().nullable(),
  received_by_user_id: model.text().nullable(),

  voided_at: model.dateTime().nullable(),
  voided_by_user_id: model.text().nullable(),
  void_reason: model.text().nullable(),
});
