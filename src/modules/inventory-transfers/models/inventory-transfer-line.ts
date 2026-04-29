import { model } from "@medusajs/utils";

export const InventoryTransferLine = model.define("inventory_transfer_line", {
  id: model.id({ prefix: "itl" }).primaryKey(),
  transfer_id: model.text(),
  product_variant_id: model.text(),
  sku: model.text(),
  description: model.text().default(""),
  qty: model.number().default(1),
  unit_cost_cents: model.number().default(0),
});
