import { model } from "@medusajs/utils";

/**
 * Monthly sales history per variant.
 *
 * source:
 *  'excel_import'   — bootstrapped from the Excel purchasing analysis file
 *  'medusa_orders'  — calculated from real Medusa orders (grows over time)
 *
 * The Daily Sales Engine prefers 'medusa_orders' when available for a given
 * month; falls back to 'excel_import' for months not yet in Medusa.
 * Both sources can coexist for the same (variant_id, month_date) during the
 * transition period — the engine sums them.
 *
 * month_date: always the first day of the month (e.g. 2024-06-01)
 */
export const PurchasingSalesHistory = model.define("purchasing_sales_history", {
  id: model.id({ prefix: "psh" }).primaryKey(),

  variant_id: model.text(),
  month_date: model.dateTime(),

  qty_sold: model.number().default(0),
  revenue: model.bigNumber().default(0),

  source: model.text().default("medusa_orders"),
});
