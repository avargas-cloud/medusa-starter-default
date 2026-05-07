import { model } from "@medusajs/utils";

/**
 * Product assignment for a Purchasing Analysis presentation group.
 */
export const PurchasingAnalysisGroupProduct = model.define(
  "purchasing_analysis_group_product",
  {
    id: model.id({ prefix: "pagp" }).primaryKey(),

    group_id: model.text(),
    product_id: model.text(),
    sort_order: model.number().default(0),
  }
);
