import { model } from "@medusajs/utils";

/**
 * One line inside an unmet-demand record.
 *
 * kind='requested'  → item the customer came looking for (top group)
 * kind='purchased'  → item the customer took home instead (bottom group)
 *
 * There is NO 1-to-1 relation between the two groups — requested and
 * purchased are two independent lists under the same record.
 *
 * Snapshots sku / title / unit_price_cents so the record stays intact if
 * the underlying product is renamed, retired, or repriced later.
 */
export const UnmetDemandItem = model.define("unmet_demand_item", {
  id: model.id({ prefix: "umditm" }).primaryKey(),
  record_id: model.text(),

  // 'requested' | 'purchased'
  kind: model.text(),

  // Product refs — product_id nullable because the customer may have asked
  // for something the store doesn't carry at all.
  product_id: model.text().nullable(),
  variant_id: model.text().nullable(),

  // Frozen at write time
  sku: model.text(),
  title: model.text(),
  // Product thumbnail URL — persisted so the line survives reload with its
  // image. Nullable: custom items (not in catalog) won't have one.
  thumbnail: model.text().nullable(),
  // Variant's customer-facing sales description. Displayed in the "Description"
  // column; falls back to title if null.
  sales_description: model.text().nullable(),

  quantity: model.number().default(1),
  unit_price_cents: model.number().default(0),
  subtotal_cents: model.number().default(0),
});
