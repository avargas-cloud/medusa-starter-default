import { model } from "@medusajs/utils";

/**
 * One line of a VendorBill — mirrors a PurchaseOrderReceiptLine but carries
 * the per-unit landed cost breakdown after confirmation.
 *
 * cbm_per_unit: cubic meters per unit, copied from product_variant.metadata.cbm
 *   at confirm time. Stored as model.number() (Medusa v2 does not expose
 *   model.float()); the value is a decimal (e.g. 0.012) cast to/from JS number.
 *   Precision is sufficient for CBM-weighted freight distribution.
 *
 * landed_unit_cost_cents = unit_cost_cents
 *                        + commission_per_unit_cents
 *                        + freight_per_unit_cents
 *                        + tariff_per_unit_cents
 */
export const VendorBillLine = model.define("vendor_bill_line", {
  id: model.id({ prefix: "vbl" }).primaryKey(),

  vendor_bill_id: model.text(),
  receipt_line_id: model.text().nullable(),

  // Deterministic link back to the PurchaseOrderLine this bill line bills.
  // Receipt-sourced lines mirror purchase_order_receipt_line.purchase_order_line_id;
  // open-PO (fill-from-po) lines store the PO line directly. Nullable for legacy
  // rows that predate this column (backfilled by migration where unambiguous).
  purchase_order_line_id: model.text().nullable(),

  line_type: model.text().default("product"), // product | qb_account
  qb_account_list_id: model.text().nullable(),
  qb_account_full_name: model.text().nullable(),
  qb_account_type: model.text().nullable(),

  // Snapshot fields (frozen from the receipt line at bill creation)
  product_variant_id: model.text().nullable(),
  sku: model.text(),
  description: model.text(),
  qty: model.number(),
  unit_cost_cents: model.number(),

  // MPN snapshot (copied from product_variant.metadata.mpn at bill creation)
  mpn: model.text().nullable(),

  // CBM — decimal stored as JS number (see note above)
  cbm_per_unit: model.number().nullable(),

  // Per-unit cost components (populated at confirm)
  commission_per_unit_cents: model.number().default(0),
  freight_per_unit_cents: model.number().default(0),
  tariff_per_unit_cents: model.number().default(0),
  landed_unit_cost_cents: model.number().default(0),
});
