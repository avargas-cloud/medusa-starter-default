import { model } from "@medusajs/utils";

/**
 * A Vendor Bill captures the actual supplier invoice for a PO receipt,
 * including commission (sourcing agent fee), freight, and tariff charges
 * that make up the landed cost of imported goods.
 *
 * Lifecycle:
 *   draft     → created from receipt lines; fields can be freely edited
 *   confirmed → landed costs calculated and distributed to lines;
 *               product_variant.metadata.avg_landed_cost_cents updated
 *   synced    → future: QB Vendor Bill Add completed
 *
 * One receipt = at most one vendor bill (purchase_order_receipt_id is UNIQUE).
 *
 * Commission modes:
 *   percent → agent fee is commission_rate_bps / 10000 × unit_cost per unit
 *   fixed   → total commission_amount_cents split evenly across all units
 *
 * Freight distribution: CBM-weighted (cbm_per_unit × qty / total_cbm)
 * Tariff distribution:  Cost-weighted  (unit_cost × qty / total_cost)
 */
export const VendorBill = model.define("vendor_bill", {
  id: model.id({ prefix: "vb" }).primaryKey(),

  // One-to-one with receipt (enforced by UNIQUE index in migration)
  purchase_order_receipt_id: model.text(),
  purchase_order_id: model.text(),

  // Lifecycle
  status: model.text().default("draft"), // draft | confirmed | synced

  // Commission (sourcing agent fee)
  commission_mode: model.text().default("percent"), // percent | fixed
  commission_rate_bps: model.number().default(0),    // 1500 = 15.00%
  commission_amount_cents: model.number().default(0), // used when mode=fixed
  commission_invoice_number: model.text().nullable(),

  // Freight
  freight_included: model.boolean().default(false),
  freight_amount_cents: model.number().default(0),
  freight_invoice_number: model.text().nullable(),

  // Tariff / duty
  tariff_included: model.boolean().default(false),
  tariff_amount_cents: model.number().default(0),
  tariff_number: model.text().nullable(),

  // Free-text notes
  notes: model.text().nullable(),

  // Confirmation audit
  confirmed_at: model.dateTime().nullable(),
  confirmed_by_user_id: model.text().nullable(),
});
