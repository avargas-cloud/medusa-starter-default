import { model } from "@medusajs/utils";

/**
 * Links a primary product variant to one or more equivalent/substitute variants.
 *
 * Rules:
 *  - Sales of alt_variant are summed into primary_variant for purchasing calculations.
 *  - Inventory of alt_variant is subtracted from recommended order qty for primary_variant.
 *  - Priority 1 = preferred alternative (used first when primary is OOS).
 *  - Cycles (A→B and B→A) are allowed at DB level but the analytics engine
 *    deduplicates to avoid double-counting.
 */
export const ProductAlternative = model.define("product_alternative", {
  id: model.id({ prefix: "palt" }).primaryKey(),

  primary_variant_id: model.text(),
  alt_variant_id: model.text(),

  priority: model.number().default(1),
  is_active: model.boolean().default(true),
});
