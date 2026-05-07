import { model } from "@medusajs/utils";

/**
 * Presentation groups for the POS Purchasing Analysis category tabs.
 *
 * Groups are product-level: assigning one product places all of its variants
 * under the group's title in the Elegant sort.
 */
export const PurchasingAnalysisGroup = model.define(
  "purchasing_analysis_group",
  {
    id: model.id({ prefix: "pag" }).primaryKey(),

    category: model.text(),
    title: model.text(),
    sort_order: model.number().default(0),
    is_active: model.boolean().default(true),
  }
);
