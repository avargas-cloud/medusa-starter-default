import { model } from "@medusajs/utils";

/**
 * One line per product variant on a factory order.
 *
 * Snapshots (sku, description) are frozen at submit time.
 * qty_received is a denormalized SUM over non-voided receipt lines.
 */
export const FactoryOrderLine = model.define("factory_order_line", {
  id: model.id({ prefix: "fol" }).primaryKey(),

  factory_order_id: model.text(),

  product_variant_id: model.text(),
  inventory_item_id: model.text(),

  sku_snapshot: model.text(),
  description_snapshot: model.text(),

  qty_ordered: model.number(),
  qty_received: model.number().default(0),
  qty_cancelled: model.number().default(0),

  unit_cost_cents: model.number(),
  tax_cents: model.number().default(0),
  total_cents: model.number(),

  status: model.text().default("open"),

  line_order: model.number().default(0),

  notes: model.text().nullable(),
});
