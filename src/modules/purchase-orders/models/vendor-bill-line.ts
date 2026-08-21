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
 *                        + tax_per_unit_cents
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
  // Sales tax share. Persisted so the landed identity below stays
  // reconstructible by the replay/drift engines — deliberately NOT rendered as
  // a column in the POS items table (the operator reads tax in the totals
  // footer only, the way QuickBooks shows it).
  tax_per_unit_cents: model.number().default(0),
  landed_unit_cost_cents: model.number().default(0),
  // EXACT landed money for the line (goods + its share of every pool),
  // allocated by `allocateLineTotalsCents` — no per-unit integer constraint,
  // so it always sums to the pool total. This is the ONE source of truth for
  // real money (AVCO numerator, QB payload amount, list/detail totals);
  // `landed_unit_cost_cents` above stays a lossy per-unit DISPLAY figure only.
  // Nullable: historical rows are backfilled separately, never inferred here.
  landed_total_cents: model.number().nullable(),

  // QuickBooks sync (Phase 0 — dormant). See docs/VENDOR_BILL_QB_SYNC_PLAN.md §3.2.
  qb_txn_line_id: model.text().nullable(), // BillLineRet.TxnLineID, needed for BillMod

  // Distinguishes a freight ExpenseLine from PO item lines and existing
  // qb_account lines. Nullable — existing rows infer their kind from
  // line_type until backfilled.
  line_kind: model.text().nullable(), // 'po_item' | 'freight_charge' | 'qb_account'
  freight_account_list_id: model.text().nullable(), // QB expense account for a freight charge line
  amount_cents: model.number().nullable(), // freight charge amount (NOT allocated to landed cost)
});
