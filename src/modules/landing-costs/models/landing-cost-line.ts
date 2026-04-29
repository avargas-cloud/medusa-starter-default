import { model } from "@medusajs/utils";

/**
 * One simulated item row in a Landing Cost calculation.
 *
 * `product_variant_id` is OPTIONAL — items can be free-form (manual SKU /
 * description) or linked to a real product variant. When linked, cbm_per_unit
 * is auto-pulled from product_variant.metadata.cbm at create time but can be
 * overridden inline.
 *
 * landed_unit_cost_cents = unit_cost_cents
 *                        + commission_per_unit_cents
 *                        + freight_per_unit_cents
 *                        + tariff_per_unit_cents
 *
 * Per-unit cost components are populated by the recalculate endpoint.
 */
export const LandingCostLine = model.define("landing_cost_line", {
  id: model.id({ prefix: "lcl" }).primaryKey(),

  landing_cost_id: model.text(),

  // Optional link to a real product variant
  product_variant_id: model.text().nullable(),

  // Item identity (snapshot, editable)
  sku: model.text(),
  mpn: model.text().nullable(),
  description: model.text(),

  // Quantities and base cost
  qty: model.number(),
  unit_cost_cents: model.number(),

  // CBM (m³) per unit — used for freight distribution
  cbm_per_unit: model.number().nullable(),

  // Computed by recalculate
  commission_per_unit_cents: model.number().default(0),
  freight_per_unit_cents: model.number().default(0),
  tariff_per_unit_cents: model.number().default(0),
  landed_unit_cost_cents: model.number().default(0),
});
